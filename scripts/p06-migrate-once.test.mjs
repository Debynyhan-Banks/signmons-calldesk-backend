import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TARGET, reserveAttempt } from "./p06-backup-once.mjs";
import {
  RUN,
  RECOVERY,
  OPTIONS,
  validatePacket,
  liveUrl,
  runPrisma,
  manifest,
  migrateCore,
  hash,
  exportInputs,
} from "./p06-migrate-once.mjs";

const revision = "a".repeat(40),
  now = Date.parse("2026-09-16T12:00:00.000Z");
const packet = () => ({
  ...TARGET,
  role: "neondb_owner",
  owner: "Debynyhan Banks",
  sourceRevision: revision,
  runDirectory: RUN,
  approvalId: "P06-R04-test",
  migrationApproved: true,
  inheritedCredentialRiskAcknowledged: true,
  noOtherConsumersConfirmed: true,
  recoveryUnchangedConfirmed: true,
  recoverySha256: RECOVERY.sha256,
  costCeilingUsd: 1,
  remainingCUh: 1,
  remainingTransferBytes: 134217728,
  startUtc: "2026-09-16T12:00:00.000Z",
  endUtc: "2026-09-16T12:10:00.000Z",
  verifiedAtUtc: "2026-09-16T11:59:59.000Z",
});
test("exact approval passes; wrong scope, privilege, revision, replay window and recovery refuse", () => {
  assert.equal(validatePacket(packet(), revision, now), 600000);
  for (const change of [
    { migrationApproved: false },
    { host: "parent.invalid" },
    { branch: "parent" },
    { database: "production" },
    { role: "p06_migration_runner" },
    { sourceRevision: "b".repeat(40) },
    { inheritedCredentialRiskAcknowledged: false },
    { noOtherConsumersConfirmed: false },
    { recoveryUnchangedConfirmed: false },
    { recoverySha256: "0".repeat(64) },
    { costCeilingUsd: 2 },
    { remainingCUh: 0 },
    { runDirectory: "/tmp" },
    { endUtc: "2026-09-16T12:10:01.000Z" },
    { verifiedAtUtc: "2026-09-16T11:54:00.000Z" },
    { startUtc: "2026-09-17T12:00:00.000Z" },
  ])
    assert.throws(() =>
      validatePacket({ ...packet(), ...change }, revision, now),
    );
  assert.throws(() => validatePacket(packet(), revision, now + 600000));
  assert.throws(() =>
    validatePacket(
      {
        ...packet(),
        startUtc: "2026-09-23T12:00:00.000Z",
        endUtc: "2026-09-23T12:10:00.000Z",
        verifiedAtUtc: "2026-09-23T12:00:00.000Z",
      },
      revision,
      Date.parse("2026-09-23T12:00:00.000Z"),
    ),
  );
});
test("fixed URL encodes private value and uses Prisma strict required TLS and limits", () => {
  const u = new URL(liveUrl("FICTIONAL@:x/secret"));
  assert.equal(u.hostname, TARGET.host);
  assert.equal(u.username, "neondb_owner");
  assert.equal(decodeURIComponent(u.password), "FICTIONAL@:x/secret");
  assert.equal(u.searchParams.get("sslmode"), "require");
  assert.equal(u.searchParams.get("sslaccept"), "strict");
  assert.equal(u.searchParams.get("options"), OPTIONS);
  assert.throws(() => liveUrl("x\n"));
});
test("immutable SQL manifest matches reviewed synthetic catalog proof", async () => {
  const proof = JSON.parse(
    await readFile(
      new URL("../evidence/APP-013/p06-r03-proof.json", import.meta.url),
    ),
  );
  assert.deepEqual(await manifest(), proof.files);
  assert.equal(proof.files.slice(13).length, 13);
});
test("atomic reservation refuses concurrent and subsequent retries", async () => {
  const dir = await mkdtemp("/private/tmp/p06-migration-reserve-");
  await chmod(dir, 0o700);
  try {
    const r = await Promise.allSettled([
      reserveAttempt(dir, packet()),
      reserveAttempt(dir, packet()),
    ]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    await assert.rejects(reserveAttempt(dir, packet()));
  } finally {
    await rm(dir, { recursive: true });
  }
});
test("actual Prisma process deadline kills child and suppresses all raw output", async () => {
  const dir = await mkdtemp("/private/tmp/p06-migration-timeout-");
  try {
    const u = new URL("postgresql://fixture@localhost/fixture");
    u.searchParams.set("options", OPTIONS);
    const r = await runPrisma({
      url: u.toString(),
      inputs: dir,
      milliseconds: 1,
    });
    assert.equal(r.timedOut, true);
    assert.equal(r.output, "");
    assert.notEqual(r.code, 0);
  } finally {
    await rm(dir, { recursive: true });
  }
});
test("aborted budget stops Prisma; private export preserves exact manifest and rejects overwrite", async () => {
  const dir = await mkdtemp("/private/tmp/p06-migration-export-");
  try {
    const files = await manifest();
    await exportInputs(dir + "/inputs", { files });
    for (const f of files)
      assert.equal(
        hash(
          await readFile(
            dir + "/inputs/migrations/" + f.name + "/migration.sql",
          ),
        ),
        f.sha256,
      );
    const config = await readFile(dir + "/inputs/prisma.config.ts", "utf8");
    assert.doesNotMatch(config, /dotenv|password/);
    await assert.rejects(exportInputs(dir + "/inputs", { files }));
    const c = new AbortController();
    c.abort();
    const u = new URL("postgresql://fixture@localhost/fixture");
    u.searchParams.set("options", OPTIONS);
    const r = await runPrisma({
      url: u.toString(),
      inputs: dir + "/inputs",
      signal: c.signal,
      milliseconds: 1000,
    });
    assert.equal(r.timedOut, true);
    assert.equal(r.output, "");
  } finally {
    await rm(dir, { recursive: true });
  }
});
test("CLI import is inert and missing approval rejects before private prompt", () => {
  const r = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./p06-migrate-once.mjs", import.meta.url))],
    { encoding: "utf8", input: "FICTIONAL_SECRET" },
  );
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /READY|FICTIONAL_SECRET/);
});
test("same core rejects metadata drift, active consumer, wrong identity and partial invocation", async () => {
  const files = Array.from({ length: 26 }, (_, i) => ({
    name: String(i),
    sha256: String(i),
  }));
  const history = files.slice(0, 13).map((x) => ({
    migration_name: x.name,
    checksum: x.sha256,
    finished: true,
    rolled_back: false,
  }));
  const proof = {
    files,
    beforeHash: hash(JSON.stringify([[], [], [], [], [], []])),
    afterHash: "unused",
  };
  for (const mode of ["identity", "catalog", "consumer", "partial"]) {
    let invoked = 0,
      unlocked = 0;
    const client = {
      query: async (sql) => {
        if (sql.startsWith("SELECT current_database"))
          return {
            rows: [
              {
                database: mode === "identity" ? "wrong" : TARGET.database,
                role: "neondb_owner",
                version: 180006,
                can_create: true,
                owned_tables: 26,
              },
            ],
          };
        if (sql.includes("pg_try_advisory_lock"))
          return { rows: [{ locked: true }] };
        if (sql.includes("pg_advisory_unlock")) {
          unlocked++;
          return { rows: [] };
        }
        if (sql.includes("migration_name,checksum")) return { rows: history };
        if (sql.includes("pg_stat_activity"))
          return { rows: [{ n: mode === "consumer" ? 1 : 0 }] };
        return { rows: mode === "catalog" ? [{ drift: true }] : [] };
      },
    };
    await assert.rejects(
      migrateCore({
        client,
        proof,
        invoke: async () => {
          invoked++;
          return { code: 1, timedOut: false, overflow: false };
        },
      }),
    );
    assert.equal(invoked, mode === "partial" ? 1 : 0);
    assert.equal(unlocked, mode === "identity" ? 0 : 1);
  }
});
