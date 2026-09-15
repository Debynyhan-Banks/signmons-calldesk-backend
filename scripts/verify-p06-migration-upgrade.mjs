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
} from "node:fs/promises";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
assert.equal(require("prisma/package.json").version, "7.10.0");
const root = fileURLToPath(new URL("../", import.meta.url));
const local = {
  host: "/tmp",
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
const temporary = await mkdtemp("/private/tmp/signmons-p06-upgrade-");
const owned = [],
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
    `postgresql://${encodeURIComponent(local.user)}@localhost/${db.name}`,
  );
  url.searchParams.set("host", "/tmp");
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
try {
  await admin.connect();
  assert.equal(
    (await admin.query("SELECT inet_server_addr() AS address")).rows[0].address,
    null,
  );
  report.server = (
    await admin.query("SHOW server_version")
  ).rows[0].server_version;
  const upgrade = await database();
  await deploy(upgrade, oldInput);
  await history(upgrade.c, 13);
  await seed(upgrade.c);
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
