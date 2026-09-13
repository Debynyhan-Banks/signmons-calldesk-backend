import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const {
  TenantSmsPolicyRegistry,
} = require("../dist/communications/tenant-sms-policy-registry.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");

export async function verifyTenantSmsPolicyRegistry({ prisma, out }) {
  const [identity] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(identity.name, /^calldesk_sms_fixture_[0-9a-f]{12}$/);
  assert.equal(identity.address, null);
  const tenant = await prisma.tenantOrganization.create({
    data: { name: "Registry Fictional Heating", timezone: "UTC" },
  });
  const other = await prisma.tenantOrganization.create({
    data: { name: "Registry Other Fixture", timezone: "UTC" },
  });
  const urls = [
    "https://policy.example.invalid/privacy",
    "https://policy.example.invalid/terms",
  ];
  let allow = urls;
  const attestations = new Map();
  const authority = {
    allowedUrls: (id) => (id === tenant.id ? allow : []),
    publication: (ref) => attestations.get(ref),
  };
  const model = (db = prisma) => new TenantSmsPolicyRegistry(db, authority);
  const actor = (
    fn,
    { tenantId = tenant.id, role = "owner", impersonated } = {},
  ) =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext(
          { tenantId, userId: "fixture-owner", role },
          impersonated,
        );
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  const content = {
    legalSender: "Fictional Heating",
    purpose: "APPOINTMENT_UPDATES_V1",
    supportEmail: "support@example.invalid",
    disclosure: "Optional service texts only. STOP to opt out. HELP for help.",
    disclosureVersion: "v1",
    privacyUrl: urls[0],
    privacyVersion: "v1",
    termsUrl: urls[1],
    termsVersion: "v1",
    effectiveAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const checks = [];
  const save = (expectedRevision, value = content, db = prisma) =>
    actor(() => model(db).saveDraft({ expectedRevision, content: value }));
  const read = (expected) =>
    actor(
      () =>
        prisma.$transaction((tx) =>
          model().readForCapture(tx, tenant.id, expected),
        ),
      { role: "webchat_integration" },
    );
  const move = (head, target, evidenceRef = "review-fixture") =>
    actor(() =>
      model().transition({
        expectedRevision: head.revision,
        target,
        evidenceRef,
      }),
    );
  await assert.rejects(model().saveDraft({ expectedRevision: 0, content }));
  for (const role of ["dispatcher", "technician", "webchat_integration"])
    await assert.rejects(
      actor(() => model().saveDraft({ expectedRevision: 0, content }), {
        role,
      }),
    );
  await assert.rejects(
    actor(() => model().saveDraft({ expectedRevision: 0, content }), {
      impersonated: tenant.id,
    }),
  );
  await assert.rejects(
    actor(() => model().saveDraft({ expectedRevision: 0, content }), {
      tenantId: other.id,
    }),
  );
  assert.equal(await prisma.tenantSmsPolicyVersion.count(), 0);
  checks.push(
    "unauthenticated, wrong role, impersonation and foreign allowlist writes refused",
  );
  await assert.rejects(read());
  const missing = await actor(() => model().read());
  assert.equal(missing.state, "MISSING");
  const drafts = await Promise.allSettled([save(0), save(0)]);
  assert.equal(drafts.filter((x) => x.status === "fulfilled").length, 1);
  let head = drafts.find((x) => x.status === "fulfilled").value;
  await assert.rejects(read());
  await assert.rejects(move(head, "CAPTURE_ELIGIBLE"));
  assert.equal(await prisma.tenantSmsPolicyVersion.count(), 1);
  head = await move(head, "REVIEWED");
  await assert.rejects(read());
  await assert.rejects(move(head, "PUBLISHED_VERIFIED", "untrusted"));
  const version = await prisma.tenantSmsPolicyVersion.findUnique({
    where: { id: head.versionId },
  });
  const proof = {
    tenantId: tenant.id,
    versionId: head.versionId,
    digest: version.digest,
    reference: "published-fixture",
    fixtureOnly: true,
    expiresAt: Date.now() + 3600000,
  };
  for (const change of [
    { tenantId: other.id },
    { versionId: randomUUID() },
    { digest: "0".repeat(64) },
    { fixtureOnly: false },
    { expiresAt: Date.now() - 1 },
  ]) {
    attestations.set(proof.reference, { ...proof, ...change });
    await assert.rejects(move(head, "PUBLISHED_VERIFIED", proof.reference));
  }
  attestations.set(proof.reference, proof);
  head = await move(head, "PUBLISHED_VERIFIED", proof.reference);
  await assert.rejects(read());
  head = await move(head, "CAPTURE_ELIGIBLE");
  const projection = await read(head);
  for (const [key, value] of Object.entries(content))
    assert.equal(projection[key], value);
  assert.equal(projection.fixtureOnly, true);
  assert.equal(projection.liveCaptureEnabled, false);
  assert.equal(projection.deliveryAuthorized, false);
  assert.equal("lastAuditId" in projection, false);
  assert.equal("tenantId" in projection, false);
  checks.push(
    "ordered lifecycle, exact public projection and no real publication or capture authority",
  );
  await assert.rejects(
    actor(
      () => prisma.$transaction((tx) => model().readForCapture(tx, tenant.id)),
      { tenantId: other.id, role: "webchat_integration" },
    ),
  );
  await assert.rejects(
    actor(
      () => prisma.$transaction((tx) => model().readForCapture(tx, tenant.id)),
      { role: "dispatcher" },
    ),
  );
  attestations.set(proof.reference, { ...proof, expiresAt: Date.now() - 1 });
  await assert.rejects(read(head));
  attestations.set(proof.reference, proof);
  allow = [];
  await assert.rejects(read(head));
  const suspended = await move(head, "SUSPENDED");
  await assert.rejects(read(head));
  allow = urls;
  checks.push(
    "read tenant/role boundaries, current attestation/allowlist and safe suspension",
  );
  await assert.rejects(
    prisma.tenantSmsPolicyVersion.update({
      where: { id: version.id },
      data: { digest: "0".repeat(64) },
    }),
  );
  await assert.rejects(
    prisma.tenantSmsPolicyVersion.delete({ where: { id: version.id } }),
  );
  const beforeAudit = await prisma.auditLog.count({
    where: { tenantId: tenant.id },
  });
  const fail = {
    $transaction: (fn, options) =>
      prisma.$transaction(async (tx) => {
        await fn(tx);
        throw Error("injected rollback");
      }, options),
  };
  await assert.rejects(
    save(suspended.revision, { ...content, disclosureVersion: "v2" }, fail),
  );
  assert.equal(await prisma.tenantSmsPolicyVersion.count(), 1);
  assert.equal(
    await prisma.auditLog.count({ where: { tenantId: tenant.id } }),
    beforeAudit,
  );
  const lost = {
    $transaction: async (fn, options) => {
      await prisma.$transaction(fn, options);
      throw Error("lost acknowledgement");
    },
  };
  await assert.rejects(
    save(suspended.revision, { ...content, disclosureVersion: "v2" }, lost),
  );
  let recovered = await actor(() => model().read());
  assert.equal(recovered.revision, suspended.revision + 1);
  await assert.rejects(save(suspended.revision));
  assert.equal(await prisma.tenantSmsPolicyVersion.count(), 2);
  assert.deepEqual(
    (
      await prisma.tenantSmsPolicyVersion.findUnique({
        where: { id: version.id },
      })
    ).content,
    version.content,
  );
  await assert.rejects(read(head));
  recovered = await move(recovered, "REVIEWED");
  const replacement = await prisma.tenantSmsPolicyVersion.findUnique({
    where: { id: recovered.versionId },
  });
  attestations.set("replacement-proof", {
    ...proof,
    versionId: replacement.id,
    digest: replacement.digest,
    reference: "replacement-proof",
  });
  recovered = await move(recovered, "PUBLISHED_VERIFIED", "replacement-proof");
  recovered = await move(recovered, "CAPTURE_ELIGIBLE");
  assert.equal((await read(recovered)).disclosureVersion, "v2");
  await assert.rejects(read(head));
  checks.push(
    "immutable history, rollback, unknown commit reload and stale replacement binding",
  );
  await assert.rejects(
    prisma.tenantSmsPolicyHead.create({
      data: {
        tenantId: other.id,
        versionId: version.id,
        revision: 1,
        state: "DRAFT",
        lastAuditId: (
          await prisma.tenantSmsPolicyHead.findUnique({
            where: { tenantId: tenant.id },
          })
        ).lastAuditId,
      },
    }),
  );
  await prisma.tenantOrganization.update({
    where: { id: tenant.id },
    data: { status: "SUSPENDED" },
  });
  await assert.rejects(read());
  await prisma.tenantOrganization.update({
    where: { id: tenant.id },
    data: { status: "ACTIVE" },
  });
  const future = await save(recovered.revision, {
    ...content,
    effectiveAt: new Date(Date.now() + 60000).toISOString(),
  });
  const futureReviewed = await move(future, "REVIEWED");
  const fv = await prisma.tenantSmsPolicyVersion.findUnique({
    where: { id: future.versionId },
  });
  attestations.set("future-proof", {
    ...proof,
    versionId: fv.id,
    digest: fv.digest,
    reference: "future-proof",
  });
  const futurePublished = await move(
    futureReviewed,
    "PUBLISHED_VERIFIED",
    "future-proof",
  );
  await assert.rejects(move(futurePublished, "CAPTURE_ELIGIBLE"));
  await assert.rejects(
    save(futurePublished.revision, {
      ...content,
      effectiveAt: new Date(Date.now() - 120000).toISOString(),
      expiresAt: new Date(Date.now() - 60000).toISOString(),
    }),
  );
  checks.push(
    "composite foreign keys, suspended tenant, future-effective and expired policy refusal",
  );
  let expiring = await save(futurePublished.revision, {
    ...content,
    expiresAt: new Date(Date.now() + 1500).toISOString(),
  });
  expiring = await move(expiring, "REVIEWED");
  const ev = await prisma.tenantSmsPolicyVersion.findUnique({
    where: { id: expiring.versionId },
  });
  attestations.set("expiry-proof", {
    ...proof,
    versionId: ev.id,
    digest: ev.digest,
    reference: "expiry-proof",
  });
  expiring = await move(expiring, "PUBLISHED_VERIFIED", "expiry-proof");
  expiring = await move(expiring, "CAPTURE_ELIGIBLE");
  await read(expiring);
  await prisma.$queryRawUnsafe("SELECT 1 FROM pg_sleep(1.6)");
  await assert.rejects(read(expiring));
  checks.push(
    "original policy expiry refuses an otherwise eligible unchanged binding",
  );
  assert.equal(await prisma.smsConsentRecord.count(), 0);
  assert.equal(
    await prisma.customer.count({ where: { consentToText: true } }),
    0,
  );
  assert.equal(await prisma.communicationEvent.count(), 0);
  await mkdir(out, { recursive: true });
  await writeFile(
    out + "/summary.json",
    JSON.stringify(
      {
        mode: "DISPOSABLE_POSTGRES_POLICY_REGISTRY",
        checks,
        versions: await prisma.tenantSmsPolicyVersion.count(),
        auditRecords: await prisma.auditLog.count({
          where: { action: "sms.policy_transition" },
        }),
        publicProjection: projection,
        providerCalls: 0,
        liveConsentWrites: 0,
        productionDatabaseWrites: 0,
      },
      null,
      2,
    ) + "\n",
  );
  return checks;
}
