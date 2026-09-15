// Fixed P06 child migration. Importing never connects or executes.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  TARGET,
  ADMIN_ROLE,
  privateFile,
  inspectStorage,
  reserveAttempt,
} from "./p06-backup-once.mjs";
import { readPipe, BackupBudget } from "./p06_backup_guards.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const RUN = "/Volumes/Signmons-P06/r04-migration-v2";
export const OPTIONS = "-c lock_timeout=5s -c statement_timeout=60s";
export const RECOVERY = Object.freeze({
  sha256: "8da4d9ce76f8ed4d96f5e33622adab6a4c7cb244689ca645186535ccf26775f9",
  expiresUtc: "2026-09-22T14:01:19.919Z",
});
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export async function manifest() {
  const base = path.join(ROOT, "prisma/migrations");
  const names = (await readdir(base, { withFileTypes: true }))
    .filter((x) => x.isDirectory())
    .map((x) => x.name)
    .sort();
  assert.equal(names.length, 26);
  return Promise.all(
    names.map(async (name) => ({
      name,
      sha256: hash(await readFile(path.join(base, name, "migration.sql"))),
    })),
  );
}
export const CATALOG_SQL = [
  `SELECT table_schema,table_name,column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema IN ('public','legacy_2025') AND table_name<>'_prisma_migrations' ORDER BY table_schema,table_name,ordinal_position`,
  `SELECT s.nspname,c.relname,n.conname,n.contype,pg_get_constraintdef(n.oid) AS definition FROM pg_constraint n JOIN pg_class c ON c.oid=n.conrelid JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname IN ('public','legacy_2025') AND c.relname<>'_prisma_migrations' ORDER BY s.nspname,c.relname,n.conname`,
  `SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname IN ('public','legacy_2025') AND tablename<>'_prisma_migrations' ORDER BY schemaname,tablename,indexname`,
  `SELECT s.nspname,c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname IN ('public','legacy_2025') AND NOT t.tgisinternal ORDER BY s.nspname,c.relname,t.tgname`,
  `SELECT s.nspname,p.proname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname IN ('public','legacy_2025') AND p.prokind='f' ORDER BY s.nspname,p.proname`,
  `SELECT s.nspname,t.typname,e.enumlabel,e.enumsortorder FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace s ON s.oid=t.typnamespace WHERE s.nspname IN ('public','legacy_2025') ORDER BY s.nspname,t.typname,e.enumsortorder`,
];
export async function catalog(c) {
  const values = [];
  for (const sql of CATALOG_SQL) values.push((await c.query(sql)).rows);
  return values;
}
export function validatePacket(p, revision, now = Date.now()) {
  assert.equal(p?.owner, "Debynyhan Banks");
  assert.equal(p.migrationApproved, true);
  assert.equal(p.inheritedCredentialRiskAcknowledged, true);
  assert.equal(p.noOtherConsumersConfirmed, true);
  assert.equal(p.recoveryUnchangedConfirmed, true);
  assert.equal(p.runDirectory, RUN);
  for (const key of ["project", "branch", "host", "database"])
    assert.equal(p[key], TARGET[key]);
  assert.equal(p.role, ADMIN_ROLE);
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.equal(p.sourceRevision, revision);
  assert.match(p.approvalId, /^P06-R04-[A-Za-z0-9-]{1,64}$/);
  assert.equal(p.recoverySha256, RECOVERY.sha256);
  assert.equal(p.costCeilingUsd, 1);
  assert.ok(p.remainingCUh >= 1 && p.remainingTransferBytes >= 134217728);
  const times = [p.startUtc, p.endUtc, p.verifiedAtUtc];
  for (const value of times) assert.equal(new Date(value).toISOString(), value);
  const [start, end, verified] = times.map(Date.parse);
  assert.ok(end > start && end - start <= 600000 && now >= start && now < end);
  assert.ok(verified <= now && now - verified <= 300000);
  assert.ok(end <= Date.parse(RECOVERY.expiresUtc));
  return end - now;
}
export function liveUrl(password) {
  assert.match(password, /^[\x20-\x7e]{1,512}$/);
  const url = new URL(
    `postgresql://${ADMIN_ROLE}@${TARGET.host}:5432/${TARGET.database}`,
  );
  url.password = password;
  url.searchParams.set("schema", "public");
  // Prisma's native connector is not libpq: verify-full would fall back to prefer.
  url.searchParams.set("sslmode", "require");
  url.searchParams.set("sslaccept", "strict");
  url.searchParams.set("options", OPTIONS);
  url.searchParams.set("application_name", "signmons-p06-r04-migration");
  return url.toString();
}
// Shared actual Prisma invocation. Raw output is available only to synthetic tests.
export function runPrisma({
  url,
  inputs,
  milliseconds = 600000,
  capture = false,
  signal,
}) {
  assert.ok(milliseconds > 0 && milliseconds <= 600000);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("options"), OPTIONS);
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(ROOT, "node_modules/prisma/build/index.js"),
        "migrate",
        "deploy",
        "--config",
        path.join(inputs, "prisma.config.ts"),
      ],
      {
        cwd: inputs,
        detached: true,
        env: {
          PATH: path.dirname(process.execPath) + ":/usr/bin:/bin",
          DATABASE_URL: url,
          PRISMA_HIDE_UPDATE_MESSAGE: "1",
          CHECKPOINT_DISABLE: "1",
          TMPDIR: inputs,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      timedOut = false,
      overflow = false;
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, milliseconds);
    const cancel = () => {
      timedOut = true;
      kill();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    process.on("SIGTERM", cancel);
    process.on("SIGINT", cancel);
    process.on("SIGHUP", cancel);
    let bytes = 0;
    const collect = (chunk) => {
      bytes += chunk.length;
      if (bytes > 1048576) {
        overflow = true;
        kill();
      } else if (capture) output += chunk;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => {
      output = "";
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      process.off("SIGTERM", cancel);
      process.off("SIGINT", cancel);
      process.off("SIGHUP", cancel);
      signal?.removeEventListener("abort", cancel);
      resolve({ code, output, timedOut, overflow });
    });
  });
}
export async function exportInputs(inputs, proof) {
  await mkdir(inputs, { mode: 0o700 });
  await mkdir(inputs + "/migrations", { mode: 0o700 });
  for (const file of proof.files) {
    const sql = await readFile(
      path.join(ROOT, "prisma/migrations", file.name, "migration.sql"),
    );
    assert.equal(hash(sql), file.sha256);
    await mkdir(path.join(inputs, "migrations", file.name), { mode: 0o700 });
    await writeFile(
      path.join(inputs, "migrations", file.name, "migration.sql"),
      sql,
      { mode: 0o600, flag: "wx" },
    );
  }
  for (const [source, destination] of [
    ["prisma/schema.prisma", "schema.prisma"],
    ["prisma/migrations/migration_lock.toml", "migrations/migration_lock.toml"],
  ])
    await writeFile(
      path.join(inputs, destination),
      await readFile(path.join(ROOT, source)),
      { mode: 0o600, flag: "wx" },
    );
  await writeFile(
    inputs + "/prisma.config.ts",
    `export default {schema:${JSON.stringify(inputs + "/schema.prisma")},migrations:{path:${JSON.stringify(inputs + "/migrations")}},datasource:{url:process.env.DATABASE_URL}};\n`,
    { mode: 0o600, flag: "wx" },
  );
}
export async function checkHistory(c, files, count) {
  const rows = (
    await c.query(
      "SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolled_back FROM public._prisma_migrations ORDER BY migration_name",
    )
  ).rows;
  assert.deepEqual(
    rows,
    files.slice(0, count).map((x) => ({
      migration_name: x.name,
      checksum: x.sha256,
      finished: true,
      rolled_back: false,
    })),
  );
}
export async function migrateCore({
  client,
  proof,
  invoke,
  database = TARGET.database,
  role = ADMIN_ROLE,
}) {
  const identity = (
    await client.query(
      "SELECT current_database() AS database,current_user AS role,current_setting('server_version_num')::int AS version,has_schema_privilege(current_user,'public','CREATE') AS can_create,(SELECT count(*)::int FROM pg_tables WHERE schemaname IN ('public','legacy_2025') AND tableowner=current_user) AS owned_tables",
    )
  ).rows[0];
  assert.equal(identity.database, database);
  assert.equal(identity.role, role);
  assert.ok(identity.version >= 180000 && identity.version < 190000);
  assert.equal(identity.can_create, true);
  assert.equal(identity.owned_tables, 26);
  const locked = (
    await client.query("SELECT pg_try_advisory_lock(604013,4) AS locked")
  ).rows[0].locked;
  assert.equal(locked, true);
  try {
    await checkHistory(client, proof.files, 13);
    assert.equal(hash(JSON.stringify(await catalog(client))), proof.beforeHash);
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
        )
      ).rows[0].n,
      0,
    );
    const result = await invoke();
    assert.equal(result.timedOut, false);
    assert.equal(result.overflow, false);
    assert.equal(result.code, 0);
    await checkHistory(client, proof.files, 26);
    assert.equal(hash(JSON.stringify(await catalog(client))), proof.afterHash);
    return { status: "MIGRATION_VERIFIED", applied: 26 };
  } finally {
    await client.query("SELECT pg_advisory_unlock(604013,4)");
  }
}
async function live(packet) {
  const revision = execFileSync(
    "/usr/bin/git",
    ["-C", ROOT, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  validatePacket(packet, revision);
  assert.equal(
    execFileSync("/usr/bin/git", ["-C", ROOT, "status", "--porcelain"], {
      encoding: "utf8",
    }).trim(),
    "",
  );
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(ROOT, "node_modules/prisma/package.json"),
        "utf8",
      ),
    ).version,
    "7.10.0",
  );
  const proofBytes = await readFile(
    path.join(ROOT, "evidence/APP-013/p06-r03-proof.json"),
  );
  assert.equal(hash(proofBytes), packet.proofSha256);
  const proof = JSON.parse(proofBytes);
  assert.deepEqual(await manifest(), proof.files);
  await inspectStorage();
  await privateFile(RUN + "/approval.json", 16384);
  const recoveryRoot = "/Volumes/Signmons-P06/r02-backup-admin-v2";
  const recovery = JSON.parse(
    (await privateFile(recoveryRoot + "/result.json", 16384)).data,
  );
  assert.equal(recovery.matched, true);
  assert.equal(recovery.sha256, RECOVERY.sha256);
  assert.equal(recovery.retentionExpiresUtc, RECOVERY.expiresUtc);
  // Compare bytes only; never inspect or log archive content.
  const archiveInfo = await stat(recoveryRoot + "/source.dump");
  assert.equal(archiveInfo.size, 198833);
  assert.equal(
    hash(await readFile(recoveryRoot + "/source.dump")),
    RECOVERY.sha256,
  );
  assert.ok((await stat("/dev/stdin")).isFIFO());
  await reserveAttempt(RUN, packet);
  const budget = await BackupBudget.create({
    roots: [RUN],
    milliseconds: validatePacket(packet, revision),
  });
  let client,
    password,
    result = { status: "REFUSED_OR_PARTIAL", applied: null };
  try {
    process.stdout.write("READY\n");
    password = await readPipe(process.stdin, budget);
    validatePacket(packet, revision);
    client = new pg.Client({
      host: TARGET.host,
      port: 5432,
      database: TARGET.database,
      user: ADMIN_ROLE,
      password,
      ssl: { rejectUnauthorized: true },
      options: OPTIONS,
      connectionTimeoutMillis: 5000,
      query_timeout: 60000,
      application_name: "signmons-p06-r04-guard",
    });
    client.on("error", () => budget.abort("CONNECTION_FAILED"));
    await budget.race(client.connect());
    const inputs = RUN + "/inputs";
    await exportInputs(inputs, proof);
    const url = liveUrl(password);
    password = undefined;
    const closeOnAbort = () => {
      void client.end().catch(() => {});
    };
    budget.signal.addEventListener("abort", closeOnAbort, { once: true });
    const guardedClient = {
      query: (sql) => {
        budget.assertActive();
        return budget.race(client.query(sql));
      },
    };
    try {
      result = await migrateCore({
        client: guardedClient,
        proof,
        invoke: () =>
          runPrisma({
            url,
            inputs,
            milliseconds: validatePacket(packet, revision),
            signal: budget.signal,
          }),
      });
    } finally {
      budget.signal.removeEventListener("abort", closeOnAbort);
    }
  } finally {
    password = undefined;
    budget.close();
    if (client) await client.end().catch(() => {});
    await writeFile(
      RUN + "/result.json",
      JSON.stringify({
        ...result,
        approvalId: packet.approvalId,
        sourceRevision: revision,
        finishedUtc: new Date().toISOString(),
        cleanup: "CONNECTION_CLOSED_IMAGE_REQUIRES_LOCK",
      }),
      { mode: 0o600, flag: "wx" },
    );
  }
  process.stdout.write("MIGRATION_COMPLETE\n");
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.umask(0o077);
  try {
    assert.deepEqual(process.argv.slice(2), [
      "--approved-child-migration",
      RUN + "/approval.json",
    ]);
    const p = JSON.parse(
      (await privateFile(RUN + "/approval.json", 16384)).data,
    );
    await live(p);
  } catch {
    process.stderr.write(
      "MIGRATION_REFUSED_OR_PARTIAL; inspect sanitized result; no retry.\n",
    );
    process.exitCode = 1;
  }
}
