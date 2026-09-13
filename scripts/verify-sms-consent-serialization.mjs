import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const {
  SmsConsentService,
} = require("../dist/communications/sms-consent.service.js");
const {
  SmsDeliveryService,
} = require("../dist/communications/sms-delivery.service.js");
const {
  smsConsentPhoneHash,
  lockSmsConsentRecipient,
} = require("../dist/communications/sms-consent-recipient.js");

export async function verifySmsConsentSerialization({ prisma, out }) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_sms_fixture_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const tenant = await prisma.tenantOrganization.create({
    data: { name: "Suppression Fictional Fixture", timezone: "UTC" },
  });
  const other = await prisma.tenantOrganization.create({
    data: { name: "Suppression Other Fixture", timezone: "UTC" },
  });
  const phone = "+12165550183";
  const key = "local-fixture-only-not-a-production-key";
  const config = {
    smsConsentHashKey: key,
    smsDeliveryEnabled: false,
    twilioWebhookEnvironment: "staging",
    twilioTenantIdentities: [
      {
        tenantId: tenant.id,
        enabled: true,
        environment: "staging",
        phoneNumber: "+13305550123",
        timeZone: "UTC",
        outboundQuietHoursStart: 0,
        outboundQuietHoursEnd: 0,
      },
    ],
  };
  const service = (client = prisma) => new SmsConsentService(client, config);
  const keyword = (body, client = prisma, tenantId = tenant.id) =>
    service(client).handleInboundKeyword({
      tenantId,
      phoneNumber: phone,
      body,
      displayName: "Fixture",
      supportPhone: phone,
    });
  const verbal = (accepted = true, client = prisma) =>
    service(client).recordVerbalConsent({
      tenantId: tenant.id,
      phoneNumber: phone,
      accepted,
      disclosureVersion: "fixture-v1",
      evidenceAt: new Date(),
      actorId: "fixture",
      actorType: "USER",
    });
  const where = {
    tenantId_phoneHash: {
      tenantId: tenant.id,
      phoneHash: smsConsentPhoneHash(key, tenant.id, phone),
    },
  };
  const record = () => prisma.smsConsentRecord.findUnique({ where });
  const customer = await prisma.customer.create({
    data: { tenantId: tenant.id, phone, fullName: "Fictional Recipient" },
  });
  const checks = [];
  let providerCalls = 0;
  const delivery = new SmsDeliveryService(
    prisma,
    service(),
    {
      encrypt() {
        throw Error("Suppressed input must not be encrypted");
      },
    },
    {
      async send() {
        providerCalls++;
        throw Error("No provider calls allowed");
      },
    },
    config,
  );
  const refused = () =>
    assert.rejects(
      delivery.create({
        tenantId: tenant.id,
        to: phone,
        body: "Fixture",
        idempotencyKey: "fixture-key",
      }),
      /SMS suppressed/,
    );
  await refused();
  await keyword("START");
  assert.equal(await record(), null);
  checks.push(
    "missing consent refuses queue creation; START without prior opt-out leaves no consent row",
  );

  await verbal();
  assert.equal((await record()).revision, 1);
  await keyword("STOP");
  const stopped = await record();
  assert.equal(stopped.status, "OPTED_OUT");
  assert.equal(stopped.revision, 2);
  await assert.rejects(verbal(), /opt-out cannot be replaced/);
  assert.equal((await record()).revision, stopped.revision);
  assert.equal(
    (await prisma.customer.findUnique({ where: { id: customer.id } }))
      .consentToText,
    false,
  );
  await refused();
  checks.push(
    "STOP overrides initial legacy grant; stale verbal retry is refused without changing row or customer",
  );

  const starts = await Promise.all([keyword("START"), keyword("START")]);
  assert.equal(starts.filter((x) => x.includes("have resumed")).length, 1);
  assert.equal(starts.filter((x) => x.includes("no prior opt-out")).length, 1);
  assert.equal((await record()).revision, 3);
  await keyword("STOP");
  await keyword("STOP");
  assert.equal((await record()).revision, 5);
  assert.equal((await record()).status, "OPTED_OUT");
  checks.push(
    "concurrent START has one restoration; repeated STOP and status change-back advance revision",
  );

  // Force STOP to hold its recipient lock while stale verbal capture arrives.
  let held, release;
  const entered = new Promise((resolve) => {
    held = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const blocked = {
    $transaction: (fn) =>
      prisma.$transaction(async (tx) =>
        fn(
          new Proxy(tx, {
            get(target, prop) {
              if (prop === "smsConsentRecord")
                return {
                  findUnique: target.smsConsentRecord.findUnique.bind(
                    target.smsConsentRecord,
                  ),
                  upsert: async (args) => {
                    held();
                    await gate;
                    return target.smsConsentRecord.upsert(args);
                  },
                };
              const value = target[prop];
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      ),
  };
  const stop = keyword("STOP", blocked);
  await entered;
  const stale = assert.rejects(verbal(), /opt-out cannot be replaced/);
  release();
  await Promise.all([stop, stale]);
  assert.equal((await record()).status, "OPTED_OUT");
  checks.push("concurrent STOP lock holder defeats stale verbal capture");

  const before = await record();
  const audits = await prisma.auditLog.count({
    where: { tenantId: tenant.id },
  });
  const rollback = {
    $transaction: (fn) =>
      prisma.$transaction(async (tx) => {
        await fn(tx);
        throw Error("fixture rollback after writes");
      }),
  };
  await assert.rejects(keyword("START", rollback), /fixture rollback/);
  assert.deepEqual(await record(), before);
  assert.equal(
    await prisma.auditLog.count({ where: { tenantId: tenant.id } }),
    audits,
  );
  assert.equal(
    (await prisma.customer.findUnique({ where: { id: customer.id } }))
      .consentToText,
    false,
  );
  checks.push(
    "post-write failure rolls back status, revision, customer flag and audit together",
  );

  const unknown = {
    $transaction: async (fn) => {
      await prisma.$transaction(fn);
      throw Error("fixture lost commit response");
    },
  };
  await assert.rejects(keyword("STOP", unknown), /lost commit response/);
  await keyword("STOP"); // reconstruction/retry remains suppressed, not exactly-once audit
  assert.equal((await record()).status, "OPTED_OUT");
  assert.equal((await record()).revision, before.revision + 2);
  await prisma.smsConsentRecord.update({ where, data: { revision: 1 } });
  assert.equal((await record()).revision, before.revision + 3);
  checks.push(
    "unknown STOP commit and reconstructed retry remain suppressed; database prevents revision rollback",
  );

  await keyword("STOP", prisma, other.id);
  assert.notEqual(
    smsConsentPhoneHash(key, tenant.id, phone),
    smsConsentPhoneHash(key, other.id, phone),
  );
  const heldRevision = (await record()).revision;
  await prisma.$transaction(async (tx) => {
    await lockSmsConsentRecipient(
      tx,
      tenant.id,
      where.tenantId_phoneHash.phoneHash,
    );
    assert.equal(
      (await tx.smsConsentRecord.findUnique({ where })).revision,
      heldRevision,
    );
  });
  await refused();
  assert.equal(await delivery.processDue(), 0);
  assert.equal(await prisma.communicationEvent.count(), 0);
  assert.equal(providerCalls, 0);
  assert.equal(
    await prisma.smsConsentRecord.count({ where: { status: "OPTED_IN" } }),
    0,
  );
  checks.push(
    "tenant-bound hashes remain isolated; outbound consumer refuses suppressed recipient with zero queues/providers",
  );
  const summary = {
    mode: "DISPOSABLE_POSTGRES_ONLY",
    checks,
    localFixtureConsentRows: 2,
    finalOptedInRows: 0,
    providerCalls,
    deliveryEvents: 0,
    productionWrites: 0,
    captureEnabled: false,
    remaining:
      "P2 policy-bound capture evidence bridge and provider event replay identity; legacy keyword retries are suppressive, not audit-deduplicated",
  };
  await mkdir(out, { recursive: true });
  await writeFile(
    out + "/summary.json",
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({ suppressionChecks: checks.length, providerCalls }),
  );
}
