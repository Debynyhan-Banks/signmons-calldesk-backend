// Local-only atomic proof. No environment credentials or network providers.
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { verifyAddressOperationLedger } from "./verify-address-operation-ledger.mjs";
import { verifyAddressExecution } from "./verify-address-execution.mjs";
const require = createRequire(import.meta.url);
const { Client, Pool } = require("pg");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const {
  AddressOperationLedger,
} = require("../dist/communications/address-operation-ledger.js");
const {
  stagingAddressPacketDigest,
} = require("../dist/communications/staging-address-budget-policy.js");
const {
  CustomerConsentCredentials,
} = require("../dist/communications/customer-consent-credentials.js");
const {
  ConversationMemoryCipher,
} = require("../dist/logging/conversation-memory-cipher.service.js");
const {
  CustomerConsentResponseService,
} = require("../dist/communications/customer-consent-response.service.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");
const database = `calldesk_org_${randomBytes(6).toString("hex")}`;
assert.match(database, /^calldesk_org_[0-9a-f]{12}$/);
const local = { host: "/tmp", user: userInfo().username, port: 5432 };
const admin = new Client({ ...local, database: "postgres" });
let created = false,
  migration,
  pool,
  prisma;
try {
  await admin.connect();
  assert.equal(
    (await admin.query("SELECT inet_server_addr() AS address")).rows[0].address,
    null,
  );
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  migration = new Client({ ...local, database });
  await migration.connect();
  for (const name of (
    await readdir(new URL("../prisma/migrations/", import.meta.url))
  ).sort()) {
    if (name === "migration_lock.toml") continue;
    await migration.query(
      await readFile(
        new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url),
        "utf8",
      ),
    );
  }
  await migration.end();
  migration = null;
  pool = new Pool({ ...local, database });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const credentials = new CustomerConsentCredentials({
    activeKeyId: "fixture",
    keys: { fixture: Buffer.alloc(32, 9) },
  });
  const cipher = new ConversationMemoryCipher({
    conversationDataEncryptionKey: "9".repeat(64),
  });
  const responses = new CustomerConsentResponseService(
    prisma,
    cipher,
    credentials,
    {
      record: async () => {
        throw Error("no consent writes");
      },
    },
  );
  const tenant = await prisma.tenantOrganization.create({
    data: { name: "Fictional budget review", timezone: "UTC", settings: {} },
  });
  const actor = (fn) =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({
          tenantId: tenant.id,
          userId: "integration:budget",
          role: "webchat_integration",
        });
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  const { sessionToken } = await actor(() => responses.start());
  const scope = credentials.verifySession(sessionToken);
  const end = Math.min(Date.now() + 60000, scope.expiresAt);
  const packet = {
    mode: "STAGING_REVIEW_ONLY",
    version: "v1",
    approvalId: "fictional-approval",
    accountId: randomUUID(),
    projectId: "fictional-project",
    serviceId: "fictional-service",
    runtimeIdentity: "fixture@example.invalid",
    tenantId: tenant.id,
    sessionId: scope.sessionId,
    currency: "USD",
    rateVersion: "fictional-not-a-price",
    costMicros: 10,
    validFrom: Date.now() - 1000,
    validUntil: end,
    account: { micros: 10, requests: 1 },
    tenant: { micros: 10, requests: 1 },
    session: { micros: 10, requests: 1 },
  };
  const config = {
    ...packet,
    environment: "staging",
    enabled: true,
    packetDigest: stagingAddressPacketDigest(packet),
    rateValidUntil: end,
  };
  const policy = {
    mode: "FIXTURE_ONLY",
    approved: true,
    version: "v1",
    rateVersion: packet.rateVersion,
    costMicros: 10,
    validUntil: end,
    account: packet.account,
    tenant: packet.tenant,
    session: packet.session,
  };
  const save = (enabled) =>
    prisma.tenantOrganization.update({
      where: { id: tenant.id },
      data: { settings: { stagingAddressBudgetReview: { enabled, packet } } },
    });
  await save(true);
  const factory = (intentId, review = config) =>
    new AddressOperationLedger(prisma, credentials, {
      accountId: packet.accountId,
      stagingReview: review,
      readBinding: async () => ({ intentId, revision: 1, policy }),
    });
  const request = () => ({
    sessionToken,
    requestId: randomUUID(),
    action: "reserve",
  });
  const one = factory(randomUUID()),
    two = factory(randomUUID());
  const r1 = request(),
    r2 = request();
  const raced = await Promise.allSettled([
    actor(() => one.execute(r1)),
    actor(() => two.execute(r2)),
  ]);
  assert.equal(raced.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(await prisma.addressVerificationOperation.count(), 1);
  const winner = raced[0].status === "fulfilled" ? [one, r1] : [two, r2];
  const before = await prisma.addressVerificationOperation.findFirst();
  const replay = await actor(() => winner[0].execute(winner[1]));
  assert.equal(replay.operationId, before.id);
  assert.equal(replay.dispatchAuthorized, false);
  assert.equal(await prisma.addressVerificationOperation.count(), 1);
  await save(false);
  await assert.rejects(
    actor(() => winner[0].execute({ ...winner[1], action: "claim" })),
  );
  assert.equal(
    (await prisma.addressVerificationOperation.findFirst()).state,
    "RESERVED",
  );
  await save(true);
  const claimed = await actor(() =>
    winner[0].execute({ ...winner[1], action: "claim" }),
  );
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.dispatchAuthorized, false);
  const duplicate = await actor(() =>
    winner[0].execute({ ...winner[1], action: "claim" }),
  );
  assert.equal(duplicate.claimed, false);
  assert.equal(
    (await prisma.addressVerificationOperation.findFirst()).heldMicros,
    10n,
  );
  // An existing fixture operation is never reused with another approval digest.
  await assert.rejects(
    actor(() =>
      factory(before.intentId, { ...config, packetDigest: "changed" }).execute(
        winner[1],
      ),
    ),
  );
  console.log(
    "PASS: concurrent cap; exact replay at cap; revocation before claim; one claim; retained liability; changed approval refusal. Zero providers.",
  );
  console.log(
    await verifyAddressOperationLedger({ prisma, credentials, responses }),
  );
  console.log(await verifyAddressExecution({ prisma, credentials, responses }));
} finally {
  await migration?.end();
  await prisma?.$disconnect();
  if (pool && !pool.ended) await pool.end();
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
  console.log("Disposable budget database removed.");
}
