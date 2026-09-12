// Creates and removes only its own Unix-socket PostgreSQL database. No external providers.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { createRequire } from "node:module";
import { verifyFixtureSmsBrowser } from "./verify-fixture-sms-consent.mjs";
import { verifyTenantSmsPolicyRegistry } from "./verify-tenant-sms-policy-registry.mjs";
import { verifySmsConsentSerialization } from "./verify-sms-consent-serialization.mjs";
const require = createRequire(import.meta.url);
const { Client, Pool } = require("pg");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const {
  CustomerConsentCredentials,
} = require("../dist/communications/customer-consent-credentials.js");
const {
  DurableFixtureSmsConsent,
} = require("../dist/communications/durable-fixture-sms-consent.js");
const {
  ConversationMemoryCipher,
} = require("../dist/logging/conversation-memory-cipher.service.js");
const database = "calldesk_sms_fixture_" + randomBytes(6).toString("hex");
assert.match(database, /^calldesk_sms_fixture_[0-9a-f]{12}$/);
const local = { host: "/tmp", user: userInfo().username, port: 5432 };
const admin = new Client({ ...local, database: "postgres" });
const out = process.env.SMS_INTAKE_EVIDENCE_DIR;
assert.ok(out, "Explicit evidence output required");
let created = false,
  prisma,
  pool,
  migration;
const checks = [];
const cipher = new ConversationMemoryCipher({
  conversationDataEncryptionKey: "4".repeat(64),
});
const envelope = (claims, value) =>
  cipher.encrypt(
    JSON.stringify({
      scope: JSON.stringify([
        claims.tenantId,
        claims.conversationId,
        claims.sessionId,
      ]),
      value,
    }),
  );
try {
  await admin.connect();
  assert.equal(
    (await admin.query("SELECT inet_server_addr() AS address")).rows[0].address,
    null,
  );
  await admin.query('CREATE DATABASE "' + database + '"');
  created = true;
  migration = new Client({ ...local, database });
  await migration.connect();
  const dirs = (
    await readdir(new URL("../prisma/migrations/", import.meta.url), {
      withFileTypes: true,
    })
  )
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const dir of dirs)
    await migration.query(
      await readFile(
        new URL(
          "../prisma/migrations/" + dir + "/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  pool = new Pool({ ...local, database, options: "-c search_path=public" });
  prisma = new PrismaClient({
    adapter: new PrismaPg(pool, { schema: "public" }),
  });
  const credentials = new CustomerConsentCredentials({
    activeKeyId: "fixture",
    keys: { fixture: Buffer.alloc(32, 7) },
  });
  const make = (db = prisma, creds = credentials) =>
    new DurableFixtureSmsConsent(db, cipher, creds);
  async function seed(claims, policy) {
    await prisma.tenantOrganization.create({
      data: { id: claims.tenantId, name: "Fictional Heating", timezone: "UTC" },
    });
    const customer = await prisma.customer.create({
      data: {
        tenantId: claims.tenantId,
        phone: policy.phone,
        fullName: "Fictional Customer",
      },
    });
    await prisma.conversation.create({
      data: {
        id: claims.conversationId,
        tenantId: claims.tenantId,
        customerId: customer.id,
        customerTenantId: claims.tenantId,
        channel: "WEBCHAT",
        status: "ONGOING",
        currentFSMState: "INTAKE",
        collectedData: {
          sessionId: claims.sessionId,
          customerSessionVersion: 1,
          verificationLifecycle: {
            version: 1,
            expiresAt: claims.expiresAt,
            closedAt: null,
            purgedAt: null,
          },
        },
      },
    });
    await prisma.fixtureSmsConsentState.create({
      data: {
        tenantId: claims.tenantId,
        conversationId: claims.conversationId,
        sessionId: claims.sessionId,
        encryptedPolicy: envelope(claims, policy),
      },
    });
    return customer;
  }
  function newFixture() {
    const sessionToken = credentials.issueSession({
      tenantId: randomUUID(),
      conversationId: randomUUID(),
      sessionId: randomUUID(),
    });
    const claims = credentials.verifySession(sessionToken);
    const policy = {
      fixtureOnly: true,
      tenantId: claims.tenantId,
      sessionId: claims.sessionId,
      phone: "+12025550123",
      phoneRevision: 1,
      version: "fictional-v1",
      sender: "Fictional Heating",
      disclosure:
        "Fictional service texts only. STOP to opt out; HELP for help. Not required to purchase.",
      optedOut: false,
      active: true,
    };
    const input = {
      sessionToken,
      action: "PROMPT",
      phone: policy.phone,
      promptId: "",
      accepted: false,
    };
    return { claims, policy, input };
  }
  const f = newFixture();
  await seed(f.claims, f.policy);
  const where = {
    tenantId_conversationId: {
      tenantId: f.claims.tenantId,
      conversationId: f.claims.conversationId,
    },
  };
  const updatePolicy = (policy) =>
    prisma.fixtureSmsConsentState.update({
      where,
      data: { encryptedPolicy: envelope(f.claims, policy) },
    });
  const prompt = () => make().handle(f.input);
  const captureInput = (p) => ({
    ...f.input,
    action: "CAPTURE",
    promptId: p.promptId,
    accepted: true,
  });
  const p = await prompt(),
    cap = captureInput(p);
  const [a, b] = await Promise.all([make().handle(cap), make().handle(cap)]);
  assert.deepEqual(a, b);
  await prisma.$disconnect();
  prisma = new PrismaClient({
    adapter: new PrismaPg(pool, { schema: "public" }),
  });
  assert.deepEqual(await make().handle(cap), a);
  assert.equal(
    await prisma.auditLog.count({
      where: { action: "fixture.sms_consent_captured" },
    }),
    1,
  );
  checks.push(
    "concurrent capture, service/client restart, one original receipt and audit",
  );
  const row = await prisma.fixtureSmsConsentPrompt.findUnique({
    where: { id: p.promptId },
  });
  assert.ok(row.recordedAt);
  assert.ok(row.sourceAuditId);
  assert.equal(row.encryptedSnapshot.includes(f.policy.phone), false);
  assert.equal(
    JSON.parse(cipher.decrypt(row.encryptedSnapshot)).value.policy.disclosure,
    f.policy.disclosure,
  );
  checks.push(
    "encrypted exact disclosure/recipient evidence with atomic audit reference",
  );
  const decline = await prompt(),
    before = await prisma.auditLog.count();
  assert.equal(
    (await make().handle({ ...captureInput(decline), accepted: false })).state,
    "NOT_RECORDED",
  );
  assert.equal(
    (
      await prisma.fixtureSmsConsentPrompt.findUnique({
        where: { id: decline.promptId },
      })
    ).recordedAt,
    null,
  );
  assert.equal(await prisma.auditLog.count(), before);
  checks.push("decline writes no capture and no audit");
  for (const changed of [
    { version: "fictional-v2" },
    { phone: "+12025550124" },
    { phoneRevision: 2 },
    { sender: "Other fictional sender" },
    { disclosure: "Different disclosure" },
    { active: false },
    { optedOut: true },
  ]) {
    await updatePolicy(f.policy);
    const stale = await prompt();
    await updatePolicy({ ...f.policy, ...changed });
    await assert.rejects(make().handle(captureInput(stale)));
  }
  assert.equal((await prompt()).state, "UNAVAILABLE");
  await updatePolicy(f.policy);
  const aba = await prompt();
  await updatePolicy({ ...f.policy, optedOut: true });
  await updatePolicy(f.policy);
  await assert.rejects(make().handle(captureInput(aba)));
  checks.push(
    "current policy, recipient, revision, suspension, opt-out and change-restore fencing",
  );
  const recipientPrompt = await prompt();
  await prisma.customer.updateMany({
    where: { tenantId: f.claims.tenantId },
    data: { phone: "+12025550124" },
  });
  await assert.rejects(make().handle(captureInput(recipientPrompt)));
  await prisma.customer.updateMany({
    where: { tenantId: f.claims.tenantId },
    data: { phone: f.policy.phone },
  });
  await assert.rejects(make().handle(captureInput(recipientPrompt)));
  checks.push(
    "actual current customer phone must still match locked fixture policy",
  );
  const foreign = newFixture();
  await seed(foreign.claims, foreign.policy);
  await assert.rejects(
    make().handle({
      ...captureInput(await prompt()),
      sessionToken: foreign.input.sessionToken,
    }),
  );
  await prisma.fixtureSmsConsentState.update({
    where,
    data: { encryptedPolicy: envelope(foreign.claims, foreign.policy) },
  });
  await assert.rejects(prompt());
  await updatePolicy(f.policy);
  checks.push("cross-tenant prompt and encrypted source substitution refused");
  const rollback = await prompt();
  const failingDb = {
    $transaction: (fn, options) =>
      prisma.$transaction(
        (tx) =>
          fn(
            new Proxy(tx, {
              get(target, key) {
                if (key === "auditLog")
                  return {
                    ...target.auditLog,
                    create: async () => {
                      throw Error("injected audit failure");
                    },
                  };
                return target[key];
              },
            }),
          ),
        options,
      ),
  };
  await assert.rejects(
    make(failingDb).handle(captureInput(rollback)),
    /unconfirmed/,
  );
  assert.equal(
    (
      await prisma.fixtureSmsConsentPrompt.findUnique({
        where: { id: rollback.promptId },
      })
    ).recordedAt,
    null,
  );
  const failAfterWrite = {
    $transaction: (fn, options) =>
      prisma.$transaction(async (tx) => {
        await fn(tx);
        throw Error("rollback");
      }, options),
  };
  await assert.rejects(make(failAfterWrite).handle(captureInput(rollback)));
  assert.equal(
    (
      await prisma.fixtureSmsConsentPrompt.findUnique({
        where: { id: rollback.promptId },
      })
    ).recordedAt,
    null,
  );
  const lostCommit = {
    $transaction: async (fn, options) => {
      await prisma.$transaction(fn, options);
      throw Error("lost commit acknowledgement");
    },
  };
  await assert.rejects(
    make(lostCommit).handle(captureInput(rollback)),
    /unconfirmed/,
  );
  const recovered = await make().handle(captureInput(rollback));
  assert.equal(
    await prisma.auditLog.count({ where: { entityId: rollback.promptId } }),
    1,
  );
  assert.equal(recovered.deliveryAuthorized, false);
  checks.push(
    "audit failure and post-write rollback; unknown committed outcome recovers once",
  );
  const nearing = await prompt();
  const nearingRow = await prisma.fixtureSmsConsentPrompt.findUnique({
    where: { id: nearing.promptId },
  });
  const nearSnapshot = JSON.parse(cipher.decrypt(nearingRow.encryptedSnapshot));
  nearSnapshot.value.expiresAt = Date.now() + 1000;
  await prisma.fixtureSmsConsentPrompt.update({
    where: { id: nearing.promptId },
    data: {
      expiresAt: new Date(nearSnapshot.value.expiresAt),
      encryptedSnapshot: cipher.encrypt(JSON.stringify(nearSnapshot)),
    },
  });
  const delayed = {
    $transaction: (fn, options) =>
      prisma.$transaction(
        (tx) =>
          fn(
            new Proxy(tx, {
              get(target, key) {
                if (key === "fixtureSmsConsentPrompt")
                  return {
                    ...target.fixtureSmsConsentPrompt,
                    update: async (args) => {
                      const result =
                        await target.fixtureSmsConsentPrompt.update(args);
                      await target.$queryRawUnsafe(
                        "SELECT 1 FROM pg_sleep(1.1)",
                      );
                      return result;
                    },
                  };
                return target[key];
              },
            }),
          ),
        options,
      ),
  };
  await assert.rejects(make(delayed).handle(captureInput(nearing)));
  assert.equal(
    (
      await prisma.fixtureSmsConsentPrompt.findUnique({
        where: { id: nearing.promptId },
      })
    ).recordedAt,
    null,
  );
  assert.equal(
    await prisma.auditLog.count({ where: { entityId: nearing.promptId } }),
    0,
  );
  checks.push(
    "deadline crossing during write rolls back both capture and audit",
  );
  const corrupt = await prompt();
  await prisma.fixtureSmsConsentPrompt.update({
    where: { id: corrupt.promptId },
    data: { encryptedSnapshot: "corrupt" },
  });
  await assert.rejects(make().handle(captureInput(corrupt)));
  await prisma.fixtureSmsConsentState.update({
    where,
    data: { encryptedPolicy: "corrupt" },
  });
  await assert.rejects(prompt());
  await updatePolicy(f.policy);
  checks.push("corrupt policy and prompt fail closed");
  const exp = await prompt();
  await prisma.fixtureSmsConsentPrompt.update({
    where: { id: exp.promptId },
    data: {
      issuedAt: new Date(Date.now() - 310000),
      expiresAt: new Date(Date.now() - 10000),
    },
  });
  await assert.rejects(make().handle(captureInput(exp)));
  const beforeClose = captureInput(await prompt());
  await make().handle(beforeClose);
  await prisma.conversation.update({
    where: { id: f.claims.conversationId },
    data: {
      collectedData: {
        sessionId: f.claims.sessionId,
        customerSessionVersion: 1,
        verificationLifecycle: {
          version: 1,
          expiresAt: f.claims.expiresAt,
          closedAt: Date.now(),
          purgedAt: null,
        },
      },
    },
  });
  await assert.rejects(make().handle(beforeClose));
  checks.push(
    "expired prompt and closed session refuse even historical receipt",
  );
  const missing = newFixture();
  await seed(missing.claims, missing.policy);
  await prisma.fixtureSmsConsentState.delete({
    where: {
      tenantId_conversationId: {
        tenantId: missing.claims.tenantId,
        conversationId: missing.claims.conversationId,
      },
    },
  });
  await assert.rejects(make().handle(missing.input));
  checks.push("missing configured state refuses");
  const blocked = newFixture();
  await seed(blocked.claims, blocked.policy);
  await prisma.tenantOrganization.update({
    where: { id: blocked.claims.tenantId },
    data: { status: "SUSPENDED" },
  });
  await assert.rejects(make().handle(blocked.input));
  checks.push("suspended organization refuses");
  await assert.rejects(
    prisma.fixtureSmsConsentState.create({
      data: {
        tenantId: foreign.claims.tenantId,
        conversationId: f.claims.conversationId,
        sessionId: f.claims.sessionId,
        encryptedPolicy: envelope(f.claims, f.policy),
      },
    }),
  );
  await assert.rejects(
    prisma.fixtureSmsConsentPrompt.create({
      data: {
        id: randomUUID(),
        tenantId: foreign.claims.tenantId,
        conversationId: f.claims.conversationId,
        sessionId: f.claims.sessionId,
        encryptedSnapshot: "invalid foreign fixture",
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      },
    }),
  );
  checks.push(
    "database composite foreign keys refuse cross-tenant state and prompts",
  );
  checks.push(
    ...(await verifyTenantSmsPolicyRegistry({
      prisma,
      out: out + "/registry",
    })),
  );
  await verifyFixtureSmsBrowser({
    out: out + "/browser",
    factory: async ({ claims, policy, credentials: creds }) => {
      await seed(claims, policy);
      return { handle: (input) => make(prisma, creds).handle(input) };
    },
  });
  assert.equal(await prisma.smsConsentRecord.count(), 0);
  assert.equal(
    await prisma.customer.count({ where: { consentToText: true } }),
    0,
  );
  assert.equal(await prisma.communicationEvent.count(), 0);
  checks.push(
    "mobile/desktop real durable port, keyboard choice, no overflow, lost response and skip",
  );
  await mkdir(out, { recursive: true });
  await writeFile(
    out + "/summary.json",
    JSON.stringify(
      {
        mode: "DISPOSABLE_POSTGRES_FIXTURE_ONLY",
        checks,
        capturedEvidence: await prisma.fixtureSmsConsentPrompt.count({
          where: { recordedAt: { not: null } },
        }),
        captureAudits: await prisma.auditLog.count({
          where: { action: "fixture.sms_consent_captured" },
        }),
        liveConsentRecords: 0,
        deliveryEvents: 0,
        providerCalls: 0,
        productionDatabaseWrites: 0,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ passed: checks.length, providerCalls: 0 }));
  // Separate post-baseline integration proof creates only fictional legacy consent rows.
  await verifySmsConsentSerialization({ prisma, out: out + "/suppression" });
} finally {
  await migration?.end();
  await prisma?.$disconnect();
  if (pool && !pool.ended) await pool.end();
  if (created) await admin.query('DROP DATABASE "' + database + '"');
  await admin.end();
  if (created) console.log("Removed this run's disposable fixture database.");
}
