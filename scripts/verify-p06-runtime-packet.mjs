// U01 synthetic-only integration. Creates/owns one PG18 Unix-socket cluster;
// never consumes DATABASE_URL, cloud credentials or a live data copy.
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { createRequire } from "node:module";
import { fixture, authorization } from "./fixtures/p06-runtime-packet.mjs";
import { verifyBootstrap } from "./verify-p06-bootstrap.mjs";
import {
  reviewPacket,
  prepareBundle,
  syntheticDatabase,
  operate,
  createOperationStageEvidence,
  readOperationStageEvidence,
  operateWithStageEvidence,
} from "./p06-runtime-packet.mjs";
import {
  exportInputs,
  manifest,
  runPrisma,
  OPTIONS,
} from "./p06-migrate-once.mjs";
const require = createRequire(import.meta.url),
  { Client, Pool } = require("pg");
const { PrismaClient } = require("@prisma/client"),
  { PrismaPg } = require("@prisma/adapter-pg");
const {
  prepareControlledIntakeStartup,
} = require("../dist/communications/controlled-intake-startup.js");
const {
  ConversationMemoryCipher,
} = require("../dist/logging/conversation-memory-cipher.service.js");
const dir = await mkdtemp("/private/tmp/signmons-u01-"),
  bin = "/opt/homebrew/opt/postgresql@18/bin/";
const socket = dir + "/socket",
  data = dir + "/data";
await mkdir(socket, { mode: 0o700 });
const name = "calldesk_u01_" + randomBytes(6).toString("hex");
const connection = {
  host: socket,
  port: 5432,
  user: userInfo().username,
  database: name,
};
let started = false,
  admin,
  raw,
  prisma,
  pool,
  operator,
  runtime;
const checks = [];
const check = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
try {
  execFileSync(
    bin + "initdb",
    ["-D", data, "-A", "trust", "--no-locale", "-E", "UTF8"],
    { stdio: "ignore" },
  );
  execFileSync(
    bin + "pg_ctl",
    [
      "-D",
      data,
      "-o",
      `-k ${socket} -h '' -p 5432`,
      "-l",
      dir + "/postgres.log",
      "-w",
      "start",
    ],
    { stdio: "ignore" },
  );
  started = true;
  admin = new Client({ ...connection, database: "postgres" });
  await admin.connect();
  assert.equal(
    (await admin.query("SELECT inet_server_addr() AS address")).rows[0].address,
    null,
  );
  await admin.query(`CREATE DATABASE "${name}"`);
  const inputs = dir + "/inputs";
  await exportInputs(inputs, { files: await manifest() });
  const url = new URL(`postgresql://${connection.user}@localhost/${name}`);
  url.searchParams.set("host", socket);
  url.searchParams.set("options", OPTIONS);
  assert.equal(
    (await runPrisma({ url: url.toString(), inputs, milliseconds: 60000 }))
      .code,
    0,
  );
  raw = new Client(connection);
  await raw.connect();
  pool = new Pool(connection);
  prisma = new PrismaClient({ adapter: new PrismaPg(pool), log: [] });
  operator = syntheticDatabase(connection);
  await verifyBootstrap(prisma, raw, operator, check);
  const f = fixture(),
    r = reviewPacket(f.packet),
    tenantId = f.packet.envelope.activation.tenantId;
  await prisma.tenantOrganization.create({
    data: {
      id: tenantId,
      name: "Fictional U01",
      timezone: "UTC",
      settings: f.settings,
    },
  });
  await prisma.serviceCategory.create({
    data: { id: f.categoryId, tenantId, name: "COOLING" },
  });
  const row = () =>
    prisma.tenantOrganization.findUniqueOrThrow({ where: { id: tenantId } });
  const expectation = async () => {
    const v = await row();
    return {
      approvals: {
        runtime: v.settings.controlledRuntimeApproval ?? null,
        phone: v.settings.controlledPhoneApproval ?? null,
      },
    };
  };
  const initial = await expectation();
  const read = async (operationId) =>
    operate(f.packet, authorization(r, "readback"), operator, {
      operationId: operationId ?? authorization(r, "readback").operationId,
    });
  const revoke = () =>
    operate(f.packet, authorization(r, "revoke"), operator, {
      runtimeDigest: r.runtimeDigest,
      phoneDigest: r.phoneDigest,
    });
  for (const mutation of [
    (p) => (p.envelope.activation.organizationDigest = "f".repeat(64)),
    (p) =>
      (p.envelope.activation.allowedServiceCategoryIds = [
        "11111111-1111-4111-8111-111111111111",
      ]),
  ]) {
    const p = structuredClone(f.packet);
    mutation(p);
    const review = reviewPacket(p);
    await assert.rejects(
      operate(p, authorization(review, "activate"), operator, initial),
    );
  }
  const diagnosticPacket = structuredClone(f.packet);
  diagnosticPacket.envelope.activation.organizationDigest = "f".repeat(64);
  const diagnosticReview = reviewPacket(diagnosticPacket);
  const stageEvidence = createOperationStageEvidence();
  await assert.rejects(
    operateWithStageEvidence(
      diagnosticPacket,
      authorization(diagnosticReview, "activate"),
      operator,
      initial,
      stageEvidence,
    ),
  );
  assert.deepEqual(readOperationStageEvidence(stageEvidence), {
    status: "USED",
    stage: "CURRENT_STATE_AUTHORITY",
  });
  check("actual activation refusal records only its fixed internal stage");
  await prisma.tenantOrganization.update({
    where: { id: tenantId },
    data: { updatedAt: new Date(Date.now() + 1000) },
  });
  const unrelatedTimestampEvidence = createOperationStageEvidence();
  await assert.rejects(
    operateWithStageEvidence(
      diagnosticPacket,
      authorization(diagnosticReview, "activate"),
      operator,
      initial,
      unrelatedTimestampEvidence,
    ),
  );
  assert.deepEqual(readOperationStageEvidence(unrelatedTimestampEvidence), {
    status: "USED",
    stage: "CURRENT_STATE_AUTHORITY",
  });
  const approvalEvidence = createOperationStageEvidence();
  await assert.rejects(
    operateWithStageEvidence(
      f.packet,
      authorization(r, "activate"),
      operator,
      {
        ...initial,
        approvals: {
          runtime: { enabled: false, digest: "f".repeat(64) },
          phone: null,
        },
      },
      approvalEvidence,
    ),
  );
  assert.deepEqual(readOperationStageEvidence(approvalEvidence), {
    status: "USED",
    stage: "ACTIVATION_APPROVALS",
  });
  check("unrelated timestamp drift passes while approval mismatch refuses");
  await prisma.tenantOrganization.update({
    where: { id: tenantId },
    data: { status: "SUSPENDED" },
  });
  await assert.rejects(
    operate(
      f.packet,
      authorization(r, "activate"),
      operator,
      await expectation(),
    ),
  );
  await prisma.tenantOrganization.update({
    where: { id: tenantId },
    data: { status: "ACTIVE" },
  });
  check("actual policy/category/inactive tenant refuse");
  await raw.query(
    "UPDATE _prisma_migrations SET checksum='wrong' WHERE migration_name=(SELECT min(migration_name) FROM _prisma_migrations)",
  );
  await assert.rejects(read());
  const files = await manifest();
  await raw.query(
    "UPDATE _prisma_migrations SET checksum=$1 WHERE migration_name=$2",
    [files[0].sha256, files[0].name],
  );
  check("real migration checksum drift refuses");
  const expected = await expectation(),
    a = authorization(r, "activate");
  const race = await Promise.allSettled([
    operate(f.packet, a, operator, expected),
    operate(f.packet, authorization(r, "activate"), operator, expected),
  ]);
  assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
  const winner = race.find((x) => x.status === "fulfilled").value;
  assert.equal((await row()).settings.keep, "untouched");
  assert.equal((await read(winner.operationId)).matchingOperationAudits, 1);
  await assert.rejects(
    operate(f.packet, authorization(r, "activate"), operator, expected),
  );
  check(
    "concurrent writers commit once; stale and active replacement refuse; lost acknowledgment reconciles by audit",
  );
  const wrong = structuredClone(f.packet);
  wrong.envelope.phone.noticeVersion = "other";
  const w = reviewPacket(wrong);
  await assert.rejects(
    operate(wrong, authorization(w, "revoke"), operator, {
      runtimeDigest: w.runtimeDigest,
      phoneDigest: w.phoneDigest,
    }),
  );
  check("foreign/newer digest cannot revoke current authority");
  const versions = { ...f.values },
    used = new Set();
  const receipt = await prepareBundle(f.packet, authorization(r, "prepare"), {
    reserve: async (id) => {
      assert.ok(!used.has(id));
      used.add(id);
    },
    readVersion: async (name) => ({ name, value: versions[name] }),
    addVersion: async (name, bytes) => {
      const ref = name + "/versions/1";
      versions[ref] = bytes.toString();
      return ref;
    },
  });
  const env = {
    CONTROLLED_INTAKE_RUNTIME_JSON: JSON.stringify(f.packet.envelope),
    CONTROLLED_INTAKE_SECRETS_JSON: versions[receipt.bundleVersion],
    NODE_ENV: "production",
    GOOGLE_CLOUD_PROJECT: "signmons",
    K_SERVICE: f.packet.facts.service,
    K_CONFIGURATION: f.packet.facts.configuration,
    K_REVISION: f.packet.facts.revision,
    PORT: "8080",
    ...f.packet.facts.flags,
  };
  runtime = await prepareControlledIntakeStartup(
    env,
    () => ({
      prisma,
      cipher: new ConversationMemoryCipher({
        conversationDataEncryptionKey: "09".repeat(32),
      }),
      logging: { warn: () => undefined },
      verifyFactory: () => {
        throw Error("No provider allowed");
      },
      googlePorts: {
        token: async () => {
          throw Error("No Google allowed");
        },
        fetch: async () => {
          throw Error("No Google allowed");
        },
      },
    }),
    async () => ({ html: "fixture", script: "fixture" }),
  );
  assert.equal(typeof runtime.retire, "function");
  check(
    "generated bundle boots existing real startup/current-policy readers without provider request",
  );
  // A held reader lock prevents revocation committing ahead of that transaction.
  await raw.query("BEGIN");
  await raw.query('SELECT id FROM "TenantOrganization" WHERE id=$1 FOR SHARE', [
    tenantId,
  ]);
  let settled = false;
  const pending = revoke().finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(settled, false);
  await raw.query("COMMIT");
  assert.equal((await pending).status, "REVOKED");
  await assert.rejects(
    operate(
      f.packet,
      { ...authorization(r, "activate"), operationId: winner.operationId },
      operator,
      await expectation(),
    ),
  );
  await assert.rejects(
    prepareControlledIntakeStartup(
      env,
      () => ({ prisma, cipher: {} }),
      async () => ({ html: "fixture", script: "fixture" }),
    ),
  );
  check(
    "revocation serializes with shared readers and subsequent startup refuses",
  );
  await raw.query(
    `CREATE FUNCTION u01_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional private failure'; END $$; CREATE TRIGGER u01_audit_fail BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION u01_audit_fail()`,
  );
  const before = await row();
  await assert.rejects(
    operate(
      f.packet,
      authorization(r, "activate"),
      operator,
      await expectation(),
    ),
  );
  assert.deepEqual(await row(), before);
  await raw.query(
    'DROP TRIGGER u01_audit_fail ON "AuditLog"; DROP FUNCTION u01_audit_fail()',
  );
  check("real audit failure rolls back settings and timestamp");
  // Short new window proves cleanup remains available after startup expiry.
  const late = structuredClone(f.packet),
    end = Date.now() + 2500;
  late.envelope.activation.validFrom = new Date(
    Date.now() - 1000,
  ).toISOString();
  late.envelope.activation.validUntil = new Date(end).toISOString();
  late.envelope.phone.startsAt = Date.parse(late.envelope.activation.validFrom);
  late.envelope.phone.expiresAt = end;
  late.envelope.browserBudget.validFrom = late.envelope.phone.startsAt;
  late.envelope.browserBudget.validUntil = end;
  late.envelope.addressPolicy.validUntil = end;
  const lr = reviewPacket(late),
    la = authorization(lr, "activate");
  await operate(late, la, operator, await expectation());
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, end - Date.now() + 50)),
  );
  assert.equal(
    (
      await operate(late, authorization(lr, "revoke"), operator, {
        runtimeDigest: lr.runtimeDigest,
        phoneDigest: lr.phoneDigest,
      })
    ).status,
    "REVOKED",
  );
  await assert.rejects(
    operate(late, authorization(lr, "activate"), operator, await expectation()),
  );
  const expiredReadback = await operate(
    late,
    authorization(lr, "readback"),
    operator,
    { operationId: la.operationId },
  );
  assert.equal(expiredReadback.storedApprovalState, "REVOKED");
  assert.equal(expiredReadback.windowCurrent, false);
  assert.equal(expiredReadback.matchingOperationAudits, 1);
  check("expired run cannot activate but explicitly authorized cleanup works");
  console.log(
    JSON.stringify({
      checks: checks.length,
      liveProviderCalls: 0,
      liveSecretCalls: 0,
      realSchemaMigrations: 26,
    }),
  );
} finally {
  runtime?.retire();
  if (operator) await operator.close();
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
  if (raw) await raw.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
  if (started)
    execFileSync(bin + "pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"], {
      stdio: "ignore",
    });
  console.log(
    "Disposable database removed; owned PG18 stopped. Fictional logs retained: " +
      dir,
  );
}
