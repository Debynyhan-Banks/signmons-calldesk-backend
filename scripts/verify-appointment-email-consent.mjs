// Only called by the existing parent-owned disposable Unix-socket database.
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const {
  AppointmentEmailConsentEvidenceStore: Store,
} = require("../dist/communications/appointment-email-consent-evidence.js");
const {
  ConversationMemoryCipher: Cipher,
} = require("../dist/logging/conversation-memory-cipher.service.js");
const {
  ConversationsService: Conversations,
} = require("../dist/conversations/conversations.service.js");
const {
  SanitizationService: Sanitize,
} = require("../dist/sanitization/sanitization.service.js");
export async function verifyAppointmentEmailConsent({
  prisma,
  jobData,
  otherTenantId,
}) {
  const [database] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(database.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(database.address, null);
  const tenantId = jobData.tenantId,
    cipher = new Cipher({ conversationDataEncryptionKey: "3".repeat(64) });
  // Fictional local fixture key only. No production adapter or key is installed.
  const fingerprints = {
    fingerprint: (tenant, mailbox) => ({
      digest: createHmac("sha256", "fictional-consent-fixture-only")
        .update(JSON.stringify([tenant, mailbox]))
        .digest("hex"),
      keyVersion: "fixture-v1",
    }),
  };
  const store = new Store(cipher, fingerprints),
    conversations = new Conversations(prisma, new Sanitize());
  const scopes = [],
    checks = [];
  const check = (name) => checks.push(name);
  const originalEvents = await prisma.appointmentEmailIntent.findMany({
    orderBy: { id: "asc" },
  });
  const make = async () => {
    const sessionId = randomUUID(),
      c = await conversations.ensureConversation(tenantId, sessionId);
    const encryptedEmail = cipher.encrypt("Consent+Case@example.invalid");
    await prisma.conversation.update({
      where: { id: c.id },
      data: {
        collectedData: {
          sessionId,
          intakeEmail: {
            version: 1,
            status: "captured",
            askedAt: null,
            encryptedEmail,
          },
        },
      },
    });
    return { c, sessionId, encryptedEmail };
  };
  const meta = (f, revision = 0, response = "GRANTED") => ({
    version: 1,
    purpose: "APPOINTMENT_UPDATES_V1",
    promptVersion: "APPOINTMENT_EMAIL_OPT_IN_V1",
    sessionId: f.sessionId,
    response,
    interactionId: randomUUID(),
    expectedRevision: revision,
  });
  const audit = (tx, f, metadata, override = {}) =>
    tx.auditLog.create({
      data: {
        tenantId,
        entityType: "Conversation",
        entityId: f.c.id,
        action: "conversation.appointment_email_permission",
        actorType: "CUSTOMER",
        actorId: "intake-session",
        metadata,
        ...override,
      },
    });
  const input = (f, a) => ({
    tenantId,
    conversationId: f.c.id,
    sourceAuditId: a.id,
  });
  const record = async (f, metadata = meta(f), override = {}) =>
    prisma.$transaction(async (tx) => {
      const a = await audit(tx, f, metadata, override),
        result = await store.record(tx, input(f, a));
      return { ...result, auditId: a.id };
    });
  const evidenceCount = () =>
    prisma.appointmentEmailConsentEvidence.count({ where: { tenantId } });
  const f = await make();
  assert.equal(
    await prisma.appointmentEmailConsentScope.count({ where: { tenantId } }),
    0,
  );
  const noReceipt = await prisma
    .$transaction((tx) => store.record(tx, input(f, { id: randomUUID() })))
    .then(
      () => false,
      () => true,
    );
  assert.equal(noReceipt, true);
  assert.equal(await evidenceCount(), 0);
  check("address-only capture cannot supply consent");
  for (const override of [
    { actorType: "SYSTEM_AI" },
    { actorType: "USER" },
    { actorId: "owner" },
    { action: "conversation.email_captured" },
  ]) {
    await assert.rejects(record(f, meta(f), override));
  }
  check("non-customer or unrelated audit authority refused");
  const oldAudit = await audit(prisma, f, meta(f));
  await assert.rejects(
    prisma.$transaction((tx) => store.record(tx, input(f, oldAudit))),
  );
  check("historical receipt cannot create a new grant");
  const first = await record(f);
  scopes.push(first.scopeId);
  assert.equal(first.revision, 1);
  assert.equal(first.deliveryAuthorized, false);
  const stored = await prisma.appointmentEmailConsentEvidence.findUniqueOrThrow(
    { where: { id: first.id } },
  );
  assert.equal(stored.encryptedEmail, f.encryptedEmail);
  assert.equal(
    cipher.decrypt(stored.encryptedEmail),
    "Consent+Case@example.invalid",
  );
  assert.equal(
    stored.mailboxFingerprint,
    fingerprints.fingerprint(tenantId, "Consent+Case@example.invalid").digest,
  );
  assert.notEqual(
    stored.mailboxFingerprint,
    fingerprints.fingerprint(otherTenantId, "Consent+Case@example.invalid")
      .digest,
  );
  assert.ok(!JSON.stringify(first).includes("Consent+Case"));
  check(
    "encrypted mailbox, tenant-scoped fixture fingerprint and private-free receipt",
  );
  const replay = await prisma.$transaction((tx) =>
    store.record(tx, input(f, { id: first.auditId })),
  );
  assert.equal(replay.id, first.id);
  assert.equal(await evidenceCount(), 1);
  check("committed receipt replay is idempotent and never authorization");
  await assert.rejects(record(f, meta(f, 0)));
  check("stale revision refused");
  const second = await record(f, meta(f, 1, "REVOKED"));
  assert.equal(second.revision, 2);
  await assert.rejects(record(f, meta(f, 2, "REVOKED")));
  check("revocation appends and repeated invalid transition refuses");
  const revokedReplay = await prisma.$transaction((tx) =>
    store.record(tx, input(f, { id: first.auditId })),
  );
  assert.equal(revokedReplay.id, first.id);
  assert.equal(revokedReplay.deliveryAuthorized, false);
  assert.equal(
    await prisma.appointmentEmailConsentEvidence.count({
      where: { scopeId: first.scopeId },
    }),
    2,
  );
  check("old grant receipt replay after revocation cannot restore authority");
  const race = await Promise.allSettled([
    record(f, meta(f, 2)),
    record(f, meta(f, 2)),
  ]);
  assert.equal(race.filter((v) => v.status === "fulfilled").length, 1);
  assert.equal(race.filter((v) => v.status === "rejected").length, 1);
  assert.equal(await evidenceCount(), 3);
  check("competing same-revision responses serialize to one commit");
  const before = await evidenceCount();
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      const a = await audit(tx, f, meta(f, 3, "REVOKED"));
      await store.record(tx, input(f, a));
      throw Error("synthetic rollback");
    }),
  );
  assert.equal(await evidenceCount(), before);
  check("transaction rollback removes evidence and its audit");
  await assert.rejects(
    prisma.appointmentEmailConsentEvidence.update({
      where: { id: first.id },
      data: { decision: "DECLINED" },
    }),
  );
  await assert.rejects(
    prisma.appointmentEmailConsentScope.update({
      where: { id: first.scopeId },
      data: { sessionId: "replace" },
    }),
  );
  await assert.rejects(
    prisma.appointmentEmailConsentEvidence.create({
      data: {
        ...stored,
        id: randomUUID(),
        sourceAuditId: oldAudit.id,
        interactionId: randomUUID(),
        revision: 9,
      },
    }),
  );
  check("database immutability and gap-free revision enforced");
  await assert.rejects(
    prisma.$transaction((tx) =>
      store.record(tx, {
        ...input(f, { id: first.auditId }),
        tenantId: otherTenantId,
      }),
    ),
  );
  check("cross-tenant record refused");
  const job = await prisma.job.create({
    data: {
      ...jobData,
      intakeSessionId: f.sessionId,
      status: "CREATED",
      serviceWindowStart: null,
      serviceWindowEnd: null,
      calendarEventId: null,
    },
  });
  const link = await prisma.conversationJobLink.create({
    data: {
      tenantId,
      conversationId: f.c.id,
      conversationTenantId: tenantId,
      jobId: job.id,
      jobTenantId: tenantId,
      relationType: "CREATED_FROM",
    },
  });
  const bindingInput = { tenantId, conversationId: f.c.id, jobId: job.id };
  assert.notEqual(f.c.customerId, job.customerId);
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await store.bindJob(tx, bindingInput);
      throw Error("synthetic binding rollback");
    }),
  );
  assert.equal(
    await prisma.appointmentEmailConsentBinding.count({
      where: { scopeId: first.scopeId },
    }),
    0,
  );
  check("job binding rolls back with its owning transaction");
  const bound = await prisma.$transaction((tx) =>
    store.bindJob(tx, bindingInput),
  );
  assert.equal(bound.deliveryAuthorized, false);
  const binding = await prisma.appointmentEmailConsentBinding.findUniqueOrThrow(
    { where: { scopeId: first.scopeId } },
  );
  assert.equal(binding.jobCustomerId, job.customerId);
  assert.equal(binding.originLinkId, link.id);
  assert.deepEqual(
    await prisma.$transaction((tx) => store.bindJob(tx, bindingInput)),
    bound,
  );
  check(
    "one-time idempotent binding preserves placeholder-to-actual customer lineage",
  );
  await assert.rejects(
    prisma.appointmentEmailConsentBinding.update({
      where: { scopeId: first.scopeId },
      data: { jobCustomerId: f.c.customerId },
    }),
  );
  await assert.rejects(
    prisma.$transaction((tx) =>
      store.bindJob(tx, { ...bindingInput, tenantId: otherTenantId }),
    ),
  );
  check("binding immutable and tenant scoped");
  const extra = await make();
  await prisma.conversationJobLink.create({
    data: {
      tenantId,
      conversationId: extra.c.id,
      conversationTenantId: tenantId,
      jobId: job.id,
      jobTenantId: tenantId,
      relationType: "CREATED_FROM",
    },
  });
  await assert.rejects(
    prisma.$transaction((tx) => store.bindJob(tx, bindingInput)),
  );
  check("ambiguous CREATED_FROM origin refuses even on replay");
  await prisma.conversationJobLink.deleteMany({
    where: { conversationId: extra.c.id },
  });
  const otherJob = await prisma.job.create({
    data: {
      ...jobData,
      intakeSessionId: randomUUID(),
      status: "CREATED",
      serviceWindowStart: null,
      serviceWindowEnd: null,
      calendarEventId: null,
    },
  });
  await assert.rejects(
    prisma.$transaction((tx) =>
      store.bindJob(tx, { ...bindingInput, jobId: otherJob.id }),
    ),
  );
  check("one scope cannot bind to another job or session");
  await prisma.job.update({
    where: { id: job.id },
    data: { deletedAt: new Date() },
  });
  await assert.rejects(
    prisma.$transaction((tx) => store.bindJob(tx, bindingInput)),
  );
  await prisma.job.update({ where: { id: job.id }, data: { deletedAt: null } });
  check("deleted job refuses");
  await assert.rejects(prisma.job.delete({ where: { id: job.id } }));
  await assert.rejects(
    prisma.auditLog.delete({ where: { id: first.auditId } }),
  );
  check("independent job/audit retention cannot silently erase bound proof");
  const decline = await make(),
    declined = await record(decline, meta(decline, 0, "DECLINED"));
  scopes.push(declined.scopeId);
  assert.equal(declined.deliveryAuthorized, false);
  check("decline is evidence, never a grant");
  for (const data of [
    { channel: "SMS" },
    { channel: "VOICE" },
    { deletedAt: new Date() },
  ]) {
    await prisma.conversation.update({ where: { id: decline.c.id }, data });
    await assert.rejects(record(decline, meta(decline, 1)));
    await prisma.conversation.update({
      where: { id: decline.c.id },
      data: { channel: "WEBCHAT", deletedAt: null },
    });
  }
  check("unsupported voice/SMS authority and deleted conversation refused");
  // No production caller or event writer imports this store. Binding doesn't patch events.
  assert.deepEqual(
    await prisma.appointmentEmailIntent.findMany({ orderBy: { id: "asc" } }),
    originalEvents,
  );
  check("all pre-existing finalized event snapshots remain unchanged");
  const rollback = await make();
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      const a = await audit(tx, rollback, meta(rollback));
      await store.record(tx, input(rollback, a));
      throw Error("synthetic initial rollback");
    }),
  );
  assert.equal(
    await prisma.appointmentEmailConsentScope.count({
      where: { conversationId: rollback.c.id },
    }),
    0,
  );
  check("initial evidence failure rolls back its new scope");
  const forged = await audit(prisma, decline, meta(decline, 1));
  await assert.rejects(
    prisma.appointmentEmailConsentEvidence.create({
      data: {
        ...stored,
        id: randomUUID(),
        scopeId: first.scopeId,
        tenantId: otherTenantId,
        sourceAuditId: forged.id,
        revision: 4,
        interactionId: randomUUID(),
      },
    }),
  );
  check("database composite FK rejects cross-tenant evidence");
  const out =
    process.env.EMAIL_CONSENT_EVIDENCE_DIR ??
    join(process.cwd(), "evidence/APP-013/consent-evidence");
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, "database-summary.json"),
    JSON.stringify(
      {
        result: "PASS",
        checks,
        checkCount: checks.length,
        providerCalls: 0,
        deliveryAuthorized: false,
        productionActions: 0,
        fixtureKeyOnly: true,
        scopeRows: scopes.length,
      },
      null,
      2,
    ) + "\n",
  );
  // Explicit fixture-owned cleanup, not a retention implementation.
  await prisma.appointmentEmailConsentScope.deleteMany({
    where: { id: { in: scopes }, tenantId },
  });
  assert.equal(
    await prisma.appointmentEmailConsentEvidence.count({ where: { tenantId } }),
    0,
  );
  assert.equal(
    await prisma.appointmentEmailConsentBinding.count({ where: { tenantId } }),
    0,
  );
  return checks.map((name) => "consent evidence: " + name);
}
