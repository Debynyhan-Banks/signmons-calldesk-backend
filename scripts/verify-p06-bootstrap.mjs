// Imported only by the disposable U01 PG18 harness; no connection/CLI of its own.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  bootstrap,
  reviewBootstrap,
  bootstrapSettingsDigest,
} from "./p06-runtime-packet.mjs";

export async function verifyBootstrap(prisma, raw, operator, check) {
  const tenantId = "a1adcfd4-15be-404b-9ac3-5edb1fda20f0";
  const settings = {
    unrelated: { retainedHoldMicros: 700000 },
    controlledRuntimeApproval: { enabled: false, digest: "a".repeat(64) },
  };
  const row = await prisma.tenantOrganization.create({
    data: {
      id: tenantId,
      name: "Synthetic U02 only",
      timezone: "UTC",
      status: "SUSPENDED",
      settings,
    },
  });
  const packet = {
    version: 1,
    sourceRevision: "a".repeat(40),
    tenantId,
    expectedUpdatedAt: row.updatedAt.toISOString(),
    expectedSettingsDigest: bootstrapSettingsDigest(settings),
    categoryId: randomUUID(),
    profile: {
      companyName: "Eternity Mechanical Services LLC",
      timezone: "America/New_York",
      hours: "Fictional test hours",
      services: "Regular initial diagnosis only",
      fallback: "Synthetic test only; no dispatch.",
      greeting: "I am an automated test assistant.",
      tone: "warm",
      faqs: [
        {
          question: "Test?",
          answer: "Synthetic only.",
          source: "Test fixture",
        },
      ],
    },
    payment: {
      currency: "usd",
      serviceFeeRequired: false,
      serviceFeeCents: null,
      depositRequired: true,
      depositPolicy: { kind: "fixed", amountCents: 9900 },
      emergencyFeePolicy: { kind: "none" },
      paymentGateMode: "fail_closed",
      webhookValidationRequired: true,
    },
  };
  const authorization = (p = packet, action = "bootstrap") => ({
    owner: "Debynyhan Banks",
    action,
    operationId: randomUUID(),
    packetDigest: reviewBootstrap(p).packetDigest,
    sourceRevision: p.sourceRevision,
    startUtc: new Date(Date.now() - 1000).toISOString(),
    endUtc: new Date(Date.now() + 60000).toISOString(),
  });
  const get = () =>
    prisma.tenantOrganization.findUniqueOrThrow({ where: { id: tenantId } });
  const refused = (p, a = authorization(p)) =>
    assert.rejects(
      bootstrap(p, a, operator),
      /P06_PACKET_REFUSED_OR_UNCONFIRMED/,
    );
  assert.equal(
    bootstrapSettingsDigest({ b: 2, a: { y: 1, x: 0 } }),
    bootstrapSettingsDigest({ a: { x: 0, y: 1 }, b: 2 }),
  );
  for (const patch of [
    { tenantId: randomUUID() },
    { extra: true },
    { sourceRevision: "bad" },
    {
      payment: {
        ...packet.payment,
        serviceFeeRequired: true,
        serviceFeeCents: 15000,
      },
    },
  ]) {
    assert.throws(
      () => reviewBootstrap({ ...packet, ...patch }),
      /P06_BOOTSTRAP_INVALID/,
    );
  }
  await refused(packet, { ...authorization(), owner: "Other" });
  await refused(packet, { ...authorization(), sourceRevision: "b".repeat(40) });
  await refused(packet, {
    ...authorization(),
    endUtc: new Date(Date.now() - 1).toISOString(),
  });
  await assert.rejects(bootstrap(packet, authorization(), {}));
  await refused({ ...packet, expectedSettingsDigest: "b".repeat(64) });
  check(
    "U02 strict target/fields/policy/owner/source/window/handle and stable jsonb digest",
  );

  await prisma.tenantOrganization.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...settings,
        controlledPhoneApproval: { enabled: true, digest: "b".repeat(64) },
      },
      updatedAt: row.updatedAt,
    },
  });
  const active = await get();
  await refused({
    ...packet,
    expectedSettingsDigest: bootstrapSettingsDigest(active.settings),
  });
  await prisma.tenantOrganization.update({
    where: { id: tenantId },
    data: { settings, updatedAt: row.updatedAt },
  });
  await prisma.serviceCategory.create({
    data: { id: packet.categoryId, tenantId, name: "Existing" },
  });
  await refused(packet);
  await prisma.serviceCategory.delete({ where: { id: packet.categoryId } });
  check("U02 refuses active runtime authority or an existing category");

  await raw.query(`CREATE FUNCTION u02_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = 'controlled_intake.bootstrap' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
  await raw.query(
    'CREATE TRIGGER u02_audit_failure BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION u02_audit_failure()',
  );
  await refused(packet);
  assert.deepEqual((await get()).settings, settings);
  assert.equal((await get()).status, "SUSPENDED");
  assert.equal(await prisma.serviceCategory.count({ where: { tenantId } }), 0);
  assert.equal(await prisma.auditLog.count({ where: { tenantId } }), 0);
  await raw.query('DROP TRIGGER u02_audit_failure ON "AuditLog"');
  await raw.query("DROP FUNCTION u02_audit_failure()");
  check(
    "U02 late audit failure rolls back activation, both policy services, category and all audits",
  );

  await raw.query(`CREATE FUNCTION u02_delay() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = 'controlled_intake.bootstrap' THEN PERFORM pg_sleep(1); END IF; RETURN NEW; END $$`);
  await raw.query(
    'CREATE TRIGGER u02_delay BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION u02_delay()',
  );
  await refused(packet, {
    ...authorization(),
    endUtc: new Date(Date.now() + 500).toISOString(),
  });
  assert.equal((await get()).status, "SUSPENDED");
  assert.deepEqual((await get()).settings, settings);
  assert.equal(await prisma.auditLog.count({ where: { tenantId } }), 0);
  await raw.query('DROP TRIGGER u02_delay ON "AuditLog"');
  await raw.query("DROP FUNCTION u02_delay()");
  check(
    "U02 expiry during transaction rolls back instead of committing after authorization ends",
  );

  const a = authorization();
  const race = await Promise.allSettled([
    bootstrap(packet, a, operator),
    bootstrap(packet, a, operator),
  ]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(race.filter((r) => r.status === "rejected").length, 1);
  const current = await get();
  assert.equal(current.status, "ACTIVE");
  assert.equal(current.timezone, "America/New_York");
  assert.deepEqual(current.settings.unrelated, settings.unrelated);
  assert.deepEqual(
    current.settings.controlledRuntimeApproval,
    settings.controlledRuntimeApproval,
  );
  assert.equal(current.settings.controlledPhoneApproval, undefined);
  assert.deepEqual(
    current.settings.organizationPaymentPolicyV1.approved.draft,
    packet.payment,
  );
  assert.equal(
    current.settings.organizationProfileV1.approved.actorId,
    "Debynyhan Banks",
  );
  assert.equal(await prisma.serviceCategory.count({ where: { tenantId } }), 1);
  assert.equal(await prisma.auditLog.count({ where: { tenantId } }), 5);
  await refused(packet, a);
  await refused(packet);
  // Discarded caller result: authoritative audit readback, not a second write.
  const readback = await bootstrap(
    packet,
    authorization(packet, "bootstrap-readback"),
    operator,
  );
  assert.equal(readback.matchingBootstrapAudit, true);
  assert.equal(readback.unchangedSetup, true);
  check(
    "U02 concurrent setup once, USD99 approval/audits preserved, replay refused and readback reconciles result",
  );

  await prisma.tenantOrganization.update({
    where: { id: tenantId },
    data: { settings: { ...current.settings, newer: true } },
  });
  await refused(packet, authorization(packet, "bootstrap-suspend"));
  const changed = await bootstrap(
    packet,
    authorization(packet, "bootstrap-readback"),
    operator,
  );
  assert.equal(changed.unchangedSetup, false);
  // Synthetic reset only, so the unchanged-state suspension path can be tested.
  await prisma.tenantOrganization.update({
    where: { id: tenantId },
    data: { settings: current.settings, updatedAt: current.updatedAt },
  });
  await prisma.serviceCategory.update({
    where: { id: packet.categoryId },
    data: { basePriceCents: 1 },
  });
  await refused(packet, authorization(packet, "bootstrap-suspend"));
  assert.equal(
    (
      await bootstrap(
        packet,
        authorization(packet, "bootstrap-readback"),
        operator,
      )
    ).unchangedSetup,
    false,
  );
  await prisma.serviceCategory.update({
    where: { id: packet.categoryId },
    data: { basePriceCents: 0 },
  });
  const suspended = await bootstrap(
    packet,
    authorization(packet, "bootstrap-suspend"),
    operator,
  );
  assert.equal(suspended.status, "SUSPENDED");
  assert.deepEqual((await get()).settings, current.settings);
  assert.equal(await prisma.serviceCategory.count({ where: { tenantId } }), 1);
  await refused(packet);
  check(
    "U02 suspension refuses newer state, preserves policies/category/holds and cannot rebootstrap",
  );
}
