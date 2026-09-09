import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const {
  CustomerIntakeContinuationService: Intake,
  PROTECTED_INTAKE_TURN: TYPE,
} = require("../dist/communications/customer-intake-continuation.service.js");
const {
  CustomerConsentCredentials: Credentials,
} = require("../dist/communications/customer-consent-credentials.js");
const { CallLogService } = require("../dist/logging/call-log.service.js");
const {
  SanitizationService,
} = require("../dist/sanitization/sanitization.service.js");
export async function verifyCustomerIntakeContinuation({
  prisma,
  make,
  cipher,
  credentials,
  keys,
  tenantId,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const checks = [],
    observed = [];
  const originalJobs = await prisma.job.count(),
    originalIntents = await prisma.appointmentEmailIntent.findMany({
      orderBy: { id: "asc" },
    }),
    originalConsent = await prisma.appointmentEmailConsentEvidence.count();
  const collaborator = {
    reply: async (input) => {
      observed.push(input);
      return "Fictional scripted response";
    },
  };
  const service = new Intake(prisma, cipher, credentials, collaborator);
  const request = (session) => ({
    sessionToken: session.sessionToken,
    interactionId: randomUUID(),
    message: "Private+Fixture@example.invalid needs a fictional repair",
  });
  const events = (session) =>
    prisma.communicationEvent.findMany({
      where: { tenantId, conversationId: session.claims.conversationId },
      include: { content: true },
      orderBy: { id: "asc" },
    });
  const audits = (session) =>
    prisma.auditLog.count({
      where: {
        entityId: session.claims.conversationId,
        action: "conversation.protected_intake_turn",
      },
    });
  const a = await make(false),
    input = request(a);
  const first = await service.continue(input);
  assert.deepEqual(first, {
    reply: "Fictional scripted response",
    revision: 1,
    deliveryAuthorized: false,
  });
  const stored = await events(a);
  assert.equal(stored.length, 1);
  assert.equal(await audits(a), 1);
  assert.equal(stored[0].id, input.interactionId);
  assert.equal(stored[0].status, "RECEIVED");
  assert.equal(stored[0].content.payload.type, TYPE);
  assert.equal(
    cipher.decrypt(stored[0].content.payload.encryptedInput),
    input.message,
  );
  assert.ok(!JSON.stringify(stored).includes(input.message));
  assert.ok(!JSON.stringify(stored).includes(first.reply));
  checks.push(
    "one encrypted input/reply pair and privacy-safe audit commit together without delivery status",
  );
  const beforeCalls = observed.length;
  assert.deepEqual(
    await new Intake(prisma, cipher, new Credentials(keys)).continue(input),
    first,
  );
  assert.equal(observed.length, beforeCalls);
  assert.deepEqual(await events(a), stored);
  await assert.rejects(
    service.continue({ ...input, message: "different request" }),
  );
  checks.push(
    "fresh instance replays exact interaction without collaborator/write; altered input refuses",
  );
  const b = await make(false);
  await assert.rejects(
    service.continue({ ...input, sessionToken: b.sessionToken }),
  );
  await assert.rejects(
    service.continue({ ...input, sessionToken: a.claims.sessionId }),
  );
  const foreign = credentials.issueSession({
    tenantId: otherTenantId,
    conversationId: a.claims.conversationId,
    sessionId: a.claims.sessionId,
  });
  await assert.rejects(service.continue({ ...input, sessionToken: foreign }));
  checks.push(
    "raw session identifier, cross-tenant credential and occupied interaction from another session refuse",
  );
  const legacy = new CallLogService(prisma, new SanitizationService(), cipher);
  await legacy.createLog({
    tenantId,
    conversationId: b.claims.conversationId,
    sessionId: b.claims.sessionId,
    transcript: "UNTRUSTED LEGACY HISTORY",
    metadata: { type: TYPE },
  });
  await service.continue(request(b));
  assert.deepEqual(observed.at(-1).turns, []);
  assert.deepEqual(
    (await legacy.getRecentMessages(tenantId, b.claims.sessionId)).map(
      (row) => row.content,
    ),
    ["UNTRUSTED LEGACY HISTORY"],
  );
  checks.push(
    "legacy message/metadata cannot become authenticated history; legacy reader cannot expose protected pair",
  );
  await service.continue({ ...request(a), message: "Second private turn" });
  assert.deepEqual(observed.at(-1).turns, [
    { message: input.message, reply: first.reply },
  ]);
  checks.push(
    "scripted collaborator receives only correctly scoped decrypted prior turns",
  );
  const same = await make(false),
    sameInput = request(same);
  const both = await Promise.all([
    service.continue(sameInput),
    service.continue(sameInput),
  ]);
  assert.deepEqual(both[0], both[1]);
  assert.equal((await events(same)).length, 1);
  assert.equal(await audits(same), 1);
  checks.push(
    "concurrent identical interactions commit one pair; duplicate scripted computation is not provider exactly-once",
  );
  const race = await make(false);
  let arrivals = 0,
    release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const racing = new Intake(prisma, cipher, credentials, {
    reply: async () => {
      if (++arrivals === 2) release();
      await barrier;
      return "scripted race reply";
    },
  });
  const outcomes = await Promise.allSettled([
    racing.continue(request(race)),
    racing.continue(request(race)),
  ]);
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal((await events(race)).length, 1);
  checks.push(
    "competing different turns cannot persist a reply based on stale transcript history",
  );
  const rollback = await make(false),
    rollbackInput = request(rollback);
  const broken = {
    $transaction: (fn, options) =>
      prisma.$transaction(
        (tx) =>
          fn(
            new Proxy(tx, {
              get: (target, prop) =>
                prop === "auditLog"
                  ? {
                      create: async (data) => {
                        await target.auditLog.create(data);
                        throw Error("PRIVATE_FAILURE");
                      },
                    }
                  : target[prop],
            }),
          ),
        options,
      ),
  };
  await assert.rejects(
    new Intake(broken, cipher, credentials, collaborator).continue(
      rollbackInput,
    ),
    /unconfirmed/,
  );
  assert.equal((await events(rollback)).length, 0);
  assert.equal(await audits(rollback), 0);
  checks.push(
    "failure after real event/content/audit writes rolls back all records",
  );
  let expired = false;
  class Clock extends Credentials {
    verifySession(token, now = Date.now()) {
      return super.verifySession(token, now + (expired ? 900001 : 0));
    }
  }
  const expiring = new Intake(prisma, cipher, new Clock(keys), {
    reply: async () => {
      expired = true;
      return "expired reply";
    },
  });
  await assert.rejects(expiring.continue(rollbackInput), /invalid or expired/);
  assert.equal((await events(rollback)).length, 0);
  checks.push(
    "credential expiring during scripted computation cannot append a turn",
  );
  const closed = await make(false);
  const closing = new Intake(prisma, cipher, credentials, {
    reply: async () => {
      await prisma.conversation.update({
        where: { id: closed.claims.conversationId },
        data: { status: "COMPLETED" },
      });
      return "closed reply";
    },
  });
  await assert.rejects(closing.continue(request(closed)));
  assert.equal((await events(closed)).length, 0);
  checks.push("conversation closed between read and write refuses persistence");
  const lost = await make(false),
    lostInput = request(lost);
  let phase = 0;
  const ackLost = {
    $transaction: async (fn, options) => {
      const result = await prisma.$transaction(fn, options);
      if (++phase === 2) throw Error("LOST_ACK");
      return result;
    },
  };
  await assert.rejects(
    new Intake(ackLost, cipher, credentials, collaborator).continue(lostInput),
    /unconfirmed/,
  );
  assert.equal((await events(lost)).length, 1);
  assert.equal((await service.continue(lostInput)).revision, 1);
  assert.equal(await audits(lost), 1);
  checks.push(
    "lost commit acknowledgment recovers by same-interaction replay without another append",
  );
  assert.equal(await prisma.job.count(), originalJobs);
  assert.equal(
    await prisma.appointmentEmailConsentEvidence.count(),
    originalConsent,
  );
  assert.deepEqual(
    await prisma.appointmentEmailIntent.findMany({ orderBy: { id: "asc" } }),
    originalIntents,
  );
  checks.push(
    "continuation creates no jobs, consent, finalized email intents or delivery authority",
  );
  const out =
    process.env.CUSTOMER_INTAKE_EVIDENCE_DIR ??
    join(process.cwd(), "evidence/APP-013/customer-intake-continuation");
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, "summary.json"),
    JSON.stringify(
      {
        result: "PASS",
        checks,
        checkCount: checks.length,
        scriptedReplyCalls: observed.length,
        providerCalls: 0,
        productionActions: 0,
        newMigrations: 0,
        deliveryAuthorized: false,
        limits: [
          "No browser/AI/booking activation",
          "Only new encrypted protected turns are trusted, not legacy caller-ID history",
          "Application locks/history check are not database immutability or retention integration",
        ],
      },
      null,
      2,
    ) + "\n",
  );
}
