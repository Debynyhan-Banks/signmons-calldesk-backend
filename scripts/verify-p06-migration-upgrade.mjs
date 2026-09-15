// Local synthetic migration rehearsal. Never accepts an external database URL.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  readdir,
  writeFile,
  stat,
  realpath,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
assert.equal(require("prisma/package.json").version, "7.10.0");
const root = fileURLToPath(new URL("../", import.meta.url));
const socket = process.env.P06_PG18_SOCKET ?? "/tmp";
const encryptedWorkspace = process.env.P06_ENCRYPTED_WORKSPACE;
const roleRehearsal = process.env.P06_ROLE_REHEARSAL === "1";
if (roleRehearsal)
  assert.notEqual(
    socket,
    "/tmp",
    "role rehearsal requires private PG18 socket",
  );
if (encryptedWorkspace) {
  assert.match(
    encryptedWorkspace,
    /^\/Volumes\/Signmons-P06\/qualification-[A-Za-z0-9]+$/,
  );
  assert.equal(await realpath(encryptedWorkspace), encryptedWorkspace);
  assert.equal(socket, path.join(encryptedWorkspace, "socket"));
  assert.equal((await stat(encryptedWorkspace)).mode & 0o077, 0);
}
const backupRehearsal = process.env.P06_BACKUP_REHEARSAL === "1";
if (backupRehearsal)
  assert.notEqual(socket, "/tmp", "backup requires private PG18 socket");
if (socket !== "/tmp") {
  if (!encryptedWorkspace)
    assert.match(
      socket,
      /^\/private\/tmp\/signmons-pg18-[A-Za-z0-9]+\/socket$/,
    );
  assert.equal(await realpath(socket), socket);
  const info = await stat(socket);
  assert.ok(info.isDirectory());
  assert.equal(info.uid, userInfo().uid);
  assert.equal(info.mode & 0o077, 0, "socket directory must be private");
}
const local = {
  host: socket,
  port: 5432,
  user: userInfo().username,
  connectionTimeoutMillis: 5000,
};
const admin = new Client({ ...local, database: "postgres" });
const names = (
  await readdir(path.join(root, "prisma/migrations"), { withFileTypes: true })
)
  .filter((x) => x.isDirectory())
  .map((x) => x.name)
  .sort();
assert.equal(names.length, 26);
assert.equal(names[13], "20260908120000_add_sms_enqueue_intents");
const temporary = await mkdtemp(
  encryptedWorkspace
    ? path.join(encryptedWorkspace, "rehearsal-")
    : "/private/tmp/signmons-p06-upgrade-",
);
const owned = [],
  ownedRoles = [],
  clients = [],
  report = { version: "7.10.0", checks: [], cleanup: [] };
const hash = (data) => createHash("sha256").update(data).digest("hex");
const checksums = Object.fromEntries(
  await Promise.all(
    names.map(async (name) => [
      name,
      hash(
        await readFile(
          path.join(root, "prisma/migrations", name, "migration.sql"),
        ),
      ),
    ]),
  ),
);
await writeFile(
  path.join(temporary, "manifest.json"),
  JSON.stringify(checksums, null, 2),
);
async function exportInputs(label, count) {
  const dir = path.join(temporary, label);
  await mkdir(path.join(dir, "migrations"), { recursive: true });
  await copyFile(
    path.join(root, "prisma/schema.prisma"),
    path.join(dir, "schema.prisma"),
  );
  await copyFile(
    path.join(root, "prisma/migrations/migration_lock.toml"),
    path.join(dir, "migrations/migration_lock.toml"),
  );
  for (const name of names.slice(0, count)) {
    await mkdir(path.join(dir, "migrations", name));
    const target = path.join(dir, "migrations", name, "migration.sql");
    await copyFile(
      path.join(root, "prisma/migrations", name, "migration.sql"),
      target,
    );
    assert.equal(hash(await readFile(target)), checksums[name]);
  }
  // Generated fixture config has no dotenv import or inherited production configuration.
  await writeFile(
    path.join(dir, "prisma.config.ts"),
    `export default {schema:${JSON.stringify(path.join(dir, "schema.prisma"))},migrations:{path:${JSON.stringify(path.join(dir, "migrations"))}},datasource:{url:process.env.DATABASE_URL}};\n`,
  );
  return dir;
}
const oldInput = await exportInputs("old", 13);
const fullInput = await exportInputs("full", 26);
async function database() {
  const name = "calldesk_p06_" + randomBytes(8).toString("hex");
  assert.match(name, /^calldesk_p06_[0-9a-f]{16}$/);
  await admin.query(`CREATE DATABASE "${name}"`);
  owned.push(name);
  const c = new Client({ ...local, database: name });
  await c.connect();
  clients.push(c);
  assert.equal(
    (await c.query("SELECT inet_server_addr() AS address")).rows[0].address,
    null,
  );
  return { name, c };
}
async function deploy(db, inputs, expected = 0) {
  const url = new URL(
    `postgresql://${encodeURIComponent(db.migrationUser ?? local.user)}@localhost/${db.name}`,
  );
  url.searchParams.set("host", socket);
  url.searchParams.set("schema", "public");
  url.searchParams.set(
    "options",
    "-c lock_timeout=5s -c statement_timeout=60s",
  );
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(root, "node_modules/prisma/build/index.js"),
        "migrate",
        "deploy",
        "--config",
        path.join(inputs, "prisma.config.ts"),
      ],
      {
        cwd: inputs,
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: url.toString(),
          PRISMA_HIDE_UPDATE_MESSAGE: "1",
          CHECKPOINT_DISABLE: "1",
          ...(encryptedWorkspace ? { TMPDIR: temporary } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 120000);
    child.stdout.on("data", (x) => {
      output += x;
    });
    child.stderr.on("data", (x) => {
      output += x;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
  await writeFile(
    path.join(temporary, `deploy-${db.name}-${report.checks.length}.log`),
    result.output,
  );
  assert.equal(
    result.timedOut,
    false,
    "operator deadline reached; no safe runner qualification",
  );
  assert.equal(result.code, expected, result.output);
  report.checks.push({
    operation: "deploy",
    database: db.name,
    expected,
    milliseconds: Date.now() - started,
  });
  return result.output;
}
async function history(c, count) {
  const rows = (
    await c.query(
      "SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at FROM _prisma_migrations ORDER BY migration_name",
    )
  ).rows;
  assert.equal(rows.length, count);
  rows.forEach((row, i) => {
    assert.equal(row.migration_name, names[i]);
    assert.equal(row.checksum, checksums[names[i]]);
    assert.equal(row.finished, true);
    assert.equal(row.rolled_back_at, null);
  });
}
const tenant = "00000000-0000-4000-8000-000000000001";
const customer = "00000000-0000-4000-8000-000000000002";
async function seed(c) {
  await c.query(
    `INSERT INTO "TenantOrganization" (id,name,timezone,"updatedAt") VALUES ($1,'Fictional upgrade QA','UTC',CURRENT_TIMESTAMP)`,
    [tenant],
  );
  await c.query(
    `INSERT INTO "Customer" (id,"tenantId",phone,"fullName","updatedAt") VALUES ($1,$2,'+12025550123','Fictional customer',CURRENT_TIMESTAMP)`,
    [customer, tenant],
  );
  await c.query(
    `INSERT INTO "PropertyAddress" (id,"tenantId","customerId","customerTenantId","googlePlaceId","formattedAddress","addressComponents",latitude,longitude,"updatedAt") VALUES ('00000000-0000-4000-8000-000000000003',$1,$2,$1,'fictional-place','Fictional address','{}',1,2,CURRENT_TIMESTAMP)`,
    [tenant, customer],
  );
  await c.query(
    `INSERT INTO "SmsConsentRecord" (id,"tenantId","phoneHash",status,source,"disclosureVersion","evidenceAt","updatedAt") VALUES ('00000000-0000-4000-8000-000000000004',$1,'fictional-hash','OPTED_OUT','KEYWORD','fictional-v1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [tenant],
  );
}
async function catalog(c) {
  const queries = [
    `SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name<>'_prisma_migrations' ORDER BY table_name,ordinal_position`,
    `SELECT c.relname,n.conname,n.contype,pg_get_constraintdef(n.oid) AS definition FROM pg_constraint n JOIN pg_class c ON c.oid=n.conrelid JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND c.relname<>'_prisma_migrations' ORDER BY c.relname,n.conname`,
    `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename,indexname`,
    `SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
    `SELECT p.proname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname='public' AND p.prokind='f' ORDER BY p.proname`,
    `SELECT t.typname,e.enumlabel,e.enumsortorder FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace s ON s.oid=t.typnamespace WHERE s.nspname='public' ORDER BY t.typname,e.enumsortorder`,
  ];
  const result = [];
  for (const query of queries) result.push((await c.query(query)).rows);
  return result;
}
async function archiveRoundTrip(source) {
  const bin = "/opt/homebrew/opt/postgresql@18/bin/";
  async function command(tool, args, expected = 0) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(bin + tool, args, {
        env: {
          PATH: bin,
          LC_ALL: "C",
          ...(encryptedWorkspace ? { TMPDIR: temporary } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "",
        timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 120000);
      child.stdout.on("data", (x) => {
        output += x;
      });
      child.stderr.on("data", (x) => {
        output += x;
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output, timedOut });
      });
    });
    assert.equal(result.timedOut, false);
    assert.equal(result.code, expected, result.output);
    return result.output;
  }
  const connection = [
    "-h",
    socket,
    "-p",
    "5432",
    "-U",
    local.user,
    "--no-password",
  ];
  const archive = path.join(temporary, "synthetic.dump");
  await command("pg_dump", [...connection, "-Fc", "-f", archive, source.name]);
  const bytes = await readFile(archive);
  const restored = await database();
  await command("pg_restore", [
    ...connection,
    "--exit-on-error",
    "--single-transaction",
    "-d",
    restored.name,
    archive,
  ]);
  await history(restored.c, 13);
  assert.deepEqual(await catalog(restored.c), await catalog(source.c));
  for (const table of [
    "TenantOrganization",
    "Customer",
    "PropertyAddress",
    "SmsConsentRecord",
    "_prisma_migrations",
  ]) {
    assert.deepEqual(
      (await restored.c.query(`SELECT * FROM "${table}" ORDER BY id`)).rows,
      (await source.c.query(`SELECT * FROM "${table}" ORDER BY id`)).rows,
    );
  }
  const security = `SELECT c.relname,pg_get_userbyid(c.relowner) AS owner,c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','S') ORDER BY c.relname`;
  assert.deepEqual(
    (await restored.c.query(security)).rows,
    (await source.c.query(security)).rows,
  );
  const broken = path.join(temporary, "truncated-synthetic.dump");
  await writeFile(broken, bytes.subarray(0, Math.floor(bytes.length / 2)), {
    mode: 0o600,
  });
  const rejected = await database();
  await command(
    "pg_restore",
    [
      ...connection,
      "--exit-on-error",
      "--single-transaction",
      "-d",
      rejected.name,
      broken,
    ],
    1,
  );
  assert.equal(
    (
      await rejected.c.query(
        "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'",
      )
    ).rows[0].n,
    0,
  );
  report.checks.push({
    operation:
      "synthetic-archive-restore-history-rows-catalog-owner-acl-and-truncation-refusal",
    bytes: bytes.length,
    sha256: hash(bytes),
  });
}
async function qualifyRole(db) {
  const owner = "p06_owner_" + randomBytes(8).toString("hex");
  const runner = "p06_runner_" + randomBytes(8).toString("hex");
  for (const [name, login] of [
    [owner, "NOLOGIN"],
    [runner, "LOGIN"],
  ]) {
    await admin.query(
      `CREATE ROLE "${name}" ${login} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    ownedRoles.push(name);
  }
  await db.c.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${runner}"`);
  await db.c.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO "${runner}"`);
  const c = new Client({ ...local, user: runner, database: db.name });
  await c.connect();
  try {
    await assert.rejects(
      c.query(
        'ALTER TABLE "PropertyAddress" ALTER COLUMN latitude DROP NOT NULL',
      ),
      (e) => e.code === "42501" && /must be owner/.test(e.message),
    );
    const flags = (
      await c.query(
        "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.ok(Object.values(flags).every((v) => v === false));
    await assert.rejects(
      c.query("CREATE ROLE p06_forbidden_probe"),
      (e) => e.code === "42501",
    );
  } finally {
    await c.end();
  }
  // Explicit fixture object ownership only. Never REASSIGN OWNED on a shared owner.
  const relations = (
    await db.c.query(
      "SELECT relname FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='public' AND relkind='r' ORDER BY relname",
    )
  ).rows;
  for (const { relname } of relations)
    await db.c.query(
      `ALTER TABLE public."${relname.replaceAll('"', '""')}" OWNER TO "${owner}"`,
    );
  const types = (
    await db.c.query(
      "SELECT typname FROM pg_type JOIN pg_namespace n ON n.oid=typnamespace WHERE n.nspname='public' AND typtype='e'",
    )
  ).rows;
  for (const { typname } of types)
    await db.c.query(
      `ALTER TYPE public."${typname.replaceAll('"', '""')}" OWNER TO "${owner}"`,
    );
  const functions = (
    await db.c.query(
      "SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND prokind='f'",
    )
  ).rows;
  for (const { signature } of functions)
    await db.c.query(`ALTER FUNCTION ${signature} OWNER TO "${owner}"`);
  await db.c.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${owner}"`);
  await db.c.query(
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${runner}"`,
  );
  await admin.query(`GRANT "${owner}" TO "${runner}"`);
  db.migrationUser = runner;
  report.checks.push({
    operation: "table-grants-refuse-alter-isolated-owner-membership-qualified",
    owner,
    runner,
  });
}
try {
  await admin.connect();
  assert.equal(
    (await admin.query("SELECT inet_server_addr() AS address")).rows[0].address,
    null,
  );
  report.server = (
    await admin.query("SHOW server_version")
  ).rows[0].server_version;
  if (socket !== "/tmp") assert.match(report.server, /^18\./);
  if (encryptedWorkspace) {
    const dataDirectory = (await admin.query("SHOW data_directory")).rows[0]
      .data_directory;
    assert.equal(
      await realpath(dataDirectory),
      path.join(encryptedWorkspace, "data"),
    );
    assert.equal(
      (await admin.query("SHOW listen_addresses")).rows[0].listen_addresses,
      "",
    );
  }
  const upgrade = await database();
  await deploy(upgrade, oldInput);
  await history(upgrade.c, 13);
  await seed(upgrade.c);
  if (backupRehearsal) await archiveRoundTrip(upgrade);
  if (roleRehearsal) await qualifyRole(upgrade);
  const beforeConsent = (
    await upgrade.c.query('SELECT * FROM "SmsConsentRecord"')
  ).rows[0];
  const beforeProperty = (
    await upgrade.c.query('SELECT * FROM "PropertyAddress"')
  ).rows[0];
  await deploy(upgrade, fullInput);
  await history(upgrade.c, 26);
  const { revision, ...afterConsent } = (
    await upgrade.c.query('SELECT * FROM "SmsConsentRecord"')
  ).rows[0];
  assert.equal(revision, 1);
  assert.deepEqual(afterConsent, beforeConsent);
  assert.deepEqual(
    (await upgrade.c.query('SELECT * FROM "PropertyAddress"')).rows[0],
    beforeProperty,
  );
  await upgrade.c.query('UPDATE "SmsConsentRecord" SET status=status');
  assert.equal(
    (await upgrade.c.query('SELECT revision FROM "SmsConsentRecord"')).rows[0]
      .revision,
    2,
  );
  await upgrade.c.query('UPDATE "SmsConsentRecord" SET revision=99');
  assert.equal(
    (await upgrade.c.query('SELECT revision FROM "SmsConsentRecord"')).rows[0]
      .revision,
    3,
  );
  await upgrade.c.query(
    'UPDATE "PropertyAddress" SET "googlePlaceId"=NULL,latitude=NULL,longitude=NULL',
  );
  assert.equal(
    (await upgrade.c.query('SELECT latitude FROM "PropertyAddress"')).rows[0]
      .latitude,
    null,
  );
  await assert.rejects(
    upgrade.c.query(
      `INSERT INTO "SmsConsentRecord" SELECT '00000000-0000-4000-8000-000000000005',"tenantId",'new-fictional-hash',status,source,"disclosureVersion","evidenceAt","createdAt","updatedAt",0 FROM "SmsConsentRecord"`,
    ),
    (e) => e.code === "23514",
  );
  await assert.rejects(
    upgrade.c.query(
      `INSERT INTO "SmsConsentRecord" SELECT '00000000-0000-4000-8000-000000000005',"tenantId","phoneHash",status,source,"disclosureVersion","evidenceAt","createdAt","updatedAt",1 FROM "SmsConsentRecord"`,
    ),
    (e) => e.code === "23505",
  );
  await assert.rejects(
    upgrade.c.query(
      `UPDATE "PropertyAddress" SET "customerId"='00000000-0000-4000-8000-000000000099'`,
    ),
    (e) => e.code === "23503",
  );
  await upgrade.c.query(
    `INSERT INTO "TenantSmsPolicyVersion" (id,"tenantId",content,digest) VALUES ('00000000-0000-4000-8000-000000000006',$1,'{}',$2)`,
    [tenant, "a".repeat(64)],
  );
  await assert.rejects(
    upgrade.c.query('UPDATE "TenantSmsPolicyVersion" SET content=content'),
    (e) => e.code === "P0001",
  );
  await assert.rejects(
    upgrade.c.query('DELETE FROM "TenantSmsPolicyVersion"'),
    (e) => e.code === "P0001",
  );
  const noOp = await deploy(upgrade, fullInput);
  assert.match(noOp, /No pending migrations/);
  await history(upgrade.c, 26);
  const fresh = await database();
  await deploy(fresh, fullInput);
  await history(fresh.c, 26);
  const upgradedCatalog = await catalog(upgrade.c);
  assert.deepEqual(upgradedCatalog, await catalog(fresh.c));
  report.checks.push({
    operation:
      "preservation-revision-nullability-check-unique-fk-immutability-noop-catalog-parity",
    catalogCounts: upgradedCatalog.map((x) => x.length),
  });
  const blocked = await database();
  await deploy(blocked, oldInput);
  await seed(blocked.c);
  await blocked.c.query("BEGIN");
  await blocked.c.query(
    'LOCK TABLE "SmsConsentRecord" IN ACCESS EXCLUSIVE MODE',
  );
  let failure;
  try {
    failure = await deploy(blocked, fullInput, 1);
  } finally {
    await blocked.c.query("ROLLBACK");
  }
  assert.match(failure, /lock timeout/);
  const failedRows = (
    await blocked.c.query(
      "SELECT migration_name,finished_at IS NOT NULL AS finished FROM _prisma_migrations ORDER BY migration_name",
    )
  ).rows;
  assert.equal(failedRows.length, 24);
  assert.deepEqual(failedRows[23], {
    migration_name: names[23],
    finished: false,
  });
  assert.ok(failedRows.slice(0, 23).every((x) => x.finished));
  assert.equal(
    (
      await blocked.c.query(
        `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='SmsConsentRecord' AND column_name='revision'`,
      )
    ).rows[0].n,
    0,
  );
  report.checks.push({
    operation: "lock-timeout-stops-without-resolve-or-retry",
    history: failedRows,
  });
  report.passed = true;
} finally {
  for (const c of clients) await c.end();
  for (const name of owned) {
    assert.match(name, /^calldesk_p06_[0-9a-f]{16}$/);
    await admin.query(`DROP DATABASE "${name}"`);
    report.cleanup.push(name);
  }
  for (const name of ownedRoles.reverse()) {
    assert.match(name, /^p06_(owner|runner)_[0-9a-f]{16}$/);
    await admin.query(`DROP ROLE "${name}"`);
  }
  await admin.end();
  await writeFile(
    path.join(temporary, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        passed: report.passed ?? false,
        evidence: temporary,
        checks: report.checks,
        removedOwnedDatabases: report.cleanup,
      },
      null,
      2,
    ),
  );
}
