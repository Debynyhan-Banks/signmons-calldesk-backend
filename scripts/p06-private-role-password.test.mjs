import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import pg from "pg";
import { BackupBudget } from "./p06_backup_guards.mjs";
import {
  TARGET,
  RUN,
  TABLES,
  CATALOG,
  validateHandoff,
} from "./p06-backup-once.mjs";
import {
  validateAdminPacket,
  assertLogging,
  loggingFingerprint,
  SAFE_LOGGING,
  LOGGING_SQL,
  adminConnection,
  connectAdmin,
  exclusiveJson,
  writeRunner,
  removeRunner,
  assignCore,
  readPipe,
} from "./p06-private-role-password.mjs";
const execute = promisify(execFile),
  revision = "a".repeat(40),
  canary = "FICTIONAL_ADMIN_CANARY";
const settings = () =>
  Object.entries({ ...SAFE_LOGGING, shared_preload_libraries: "" })
    .map(([name, setting]) => ({ name, setting }))
    .sort((a, b) => a.name.localeCompare(b.name));
const packet = () => ({
  ...TARGET,
  owner: "Debynyhan Banks",
  approvalId: "P06-R02-dummy-local",
  sourceRevision: revision,
  runDirectory: RUN,
  retentionDays: 7,
  administratorCloseoutAcknowledged: true,
  startUtc: new Date(Date.now() - 1000).toISOString(),
  endUtc: new Date(Date.now() + 600000).toISOString(),
  verifiedAtUtc: new Date(Date.now() - 1000).toISOString(),
  remainingCUh: 1,
  remainingTransferBytes: 134217728,
  noOtherConsumersConfirmed: true,
  administratorPasswordAssignmentApproved: true,
  inheritedCredentialRiskAcknowledged: true,
  providerLoggingReviewApproved: true,
  providerLoggingReviewId: "dummy-local-review",
  loggingFingerprint: loggingFingerprint(settings(), []),
});
async function directory(t) {
  const root = await realpath(
    await mkdtemp("/private/tmp/p06-private-role-test-"),
  );
  t.after(() => rm(root, { recursive: true }));
  return root;
}
test("admin packet requires explicit exception, current v2 and provider review", () => {
  const p = packet();
  assert.equal(validateAdminPacket(p, revision), 120000);
  for (const delta of [
    { administratorPasswordAssignmentApproved: false },
    { inheritedCredentialRiskAcknowledged: false },
    { providerLoggingReviewApproved: false },
    { loggingFingerprint: "" },
    { providerLoggingReviewId: "" },
    { host: "parent.invalid" },
    { role: "neondb_owner" },
    { database: "postgres" },
    { runDirectory: RUN.replace("v2", "v1") },
    {
      endUtc: "2026-09-15T12:42:00.000Z",
      startUtc: "2026-09-15T12:22:00.000Z",
    },
  ])
    assert.throws(() => validateAdminPacket({ ...p, ...delta }, revision));
  const c = adminConnection(canary);
  assert.equal(c.host, TARGET.host);
  assert.equal(c.database, "neondb");
  assert.equal(c.user, "neondb_owner");
  assert.deepEqual(c.ssl, { rejectUnauthorized: true });
  assert.equal(c.connectionTimeoutMillis, 5000);
});
test("connection and certificate failures redact before any SQL", async (t) => {
  const root = await directory(t);
  for (const message of [
    "certificate verify failed: " + canary,
    "password authentication failed: " + canary,
  ]) {
    const budget = await BackupBudget.create({
      roots: [root],
      milliseconds: 100,
    });
    try {
      await assert.rejects(
        connectAdmin(
          {
            connect: async () => {
              throw Error(message);
            },
          },
          budget,
        ),
        (e) => {
          assert.equal(e.message, "ADMIN_CONNECTION_REFUSED");
          assert.equal(String(e.stack).includes(canary), false);
          return true;
        },
      );
    } finally {
      budget.close();
    }
  }
});
test("unsafe, missing, changed and utility/audit logging fail closed", () => {
  const rows = settings();
  assertLogging(rows, [], loggingFingerprint(rows, []));
  for (const [name, value] of Object.entries(SAFE_LOGGING)) {
    const unsafe = rows.map((r) =>
      r.name === name ? { ...r, setting: value === "0" ? "1" : "unsafe" } : r,
    );
    assert.throws(
      () => assertLogging(unsafe, [], loggingFingerprint(unsafe, [])),
      /LOGGING_REFUSED/,
    );
    assert.throws(() =>
      assertLogging(
        rows.filter((r) => r.name !== name),
        [],
        packet().loggingFingerprint,
      ),
    );
  }
  for (const extra of [
    [{ name: "pgaudit.log", setting: "all" }],
    [
      { name: "pg_stat_statements.track", setting: "all" },
      { name: "pg_stat_statements.track_utility", setting: "on" },
    ],
  ]) {
    const unsafe = [...rows, ...extra];
    assert.throws(() =>
      assertLogging(unsafe, [], loggingFingerprint(unsafe, [])),
    );
  }
  assert.throws(() =>
    assertLogging(
      rows,
      [{ extname: "unreviewed" }],
      packet().loggingFingerprint,
    ),
  );
});
test("exclusive private marker and runner-only file; never overwrite", async (t) => {
  const root = await directory(t),
    secret = "a".repeat(64);
  const attempts = await Promise.allSettled([
    exclusiveJson(root + "/handoff-attempt.json", {}),
    exclusiveJson(root + "/handoff-attempt.json", {}),
  ]);
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  const identity = await writeRunner(root, secret);
  assert.equal((await stat(root + "/pgpass")).mode & 0o777, 0o600);
  assert.equal(
    await readFile(root + "/pgpass", "utf8"),
    `${TARGET.host}:5432:neondb:${TARGET.role}:${secret}\n`,
  );
  await assert.rejects(writeRunner(root, secret));
  await assert.rejects(
    removeRunner(root, { dev: identity.dev, ino: identity.ino + 1 }),
    /PASSFILE_CHANGED/,
  );
  await removeRunner(root, identity);
  await assert.rejects(stat(root + "/pgpass"));
  await assert.rejects(writeRunner(root, canary), /GENERATED_SECRET_REFUSED/);
});
const roles = () =>
  ["p06_migration_owner", TARGET.role].map((rolname) => ({
    rolname,
    rolcanlogin: false,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    memberships: 0,
  }));
function fake(p, options = {}) {
  let mutations = 0,
    generated;
  return {
    get mutations() {
      return mutations;
    },
    get generated() {
      return generated;
    },
    async query(q) {
      if (q.startsWith("ALTER ROLE")) {
        mutations++;
        generated = q.match(/PASSWORD '([a-f0-9]+)'/)[1];
        if (options.failSend) throw Error(canary + q);
        return { rows: [] };
      }
      if (q === "COMMIT" && options.failCommit) throw Error(canary);
      if (q.includes("current_database() AS database"))
        return {
          rows: [
            {
              database: options.wrongDatabase ? "wrong" : "neondb",
              role: "neondb_owner",
              version: 180006,
            },
          ],
        };
      if (q.startsWith("SELECT rolname"))
        return {
          rows: roles().map((r) => ({ ...r, rolcanlogin: !!options.login })),
        };
      if (q.includes("AS can_create"))
        return {
          rows: [
            {
              can_create: true,
              can_admin: !options.noAdmin,
              sessions: 0,
              other_sessions: options.busy ? 1 : 0,
            },
          ],
        };
      if (q.includes("FROM pg_tables"))
        return {
          rows: TABLES.map((t) => ({
            ...t,
            tableowner: "neondb_owner",
            readable: true,
            writable: !!options.writeGrant,
          })),
        };
      if (q === LOGGING_SQL) return { rows: options.unsafe ? [] : settings() };
      if (q.startsWith("SELECT extname,extversion")) return { rows: [] };
      if (q.startsWith("SELECT rolvaliduntil"))
        return { rows: [{ expiry: p.endUtc }] };
      if (CATALOG.includes(q)) return { rows: [] };
      return { rows: [] };
    },
  };
}
const fakeBudget = { query: (c, q) => c.query(q), assertActive() {} };
test("one assignment, NOLOGIN preserved, generated runner secret only", async (t) => {
  const root = await directory(t),
    p = packet(),
    client = fake(p);
  const result = await assignCore({
    client,
    budget: fakeBudget,
    packet: p,
    root,
  });
  assert.equal(client.mutations, 1);
  assert.match(client.generated, /^[a-f0-9]{64}$/);
  assert.equal(result.status, "ASSIGNED_NOLOGIN");
  assert.equal(JSON.stringify(result).includes(client.generated), false);
  assert.equal(
    (await readFile(root + "/pgpass", "utf8")).includes(canary),
    false,
  );
});
test("identity/privilege/logging/file refusals precede assignment; uncertain send never retries", async (t) => {
  for (const option of [
    "wrongDatabase",
    "login",
    "noAdmin",
    "busy",
    "writeGrant",
    "unsafe",
    "failSend",
    "failCommit",
    "fileFailure",
  ]) {
    const root = await directory(t),
      p = packet(),
      client = fake(p, { [option]: true });
    await assert.rejects(
      assignCore({
        client,
        budget: fakeBudget,
        packet: p,
        root,
        ...(option === "fileFailure"
          ? {
              persist: async () => {
                throw Error(canary);
              },
            }
          : {}),
      }),
      (e) => {
        assert.equal(String(e.stack).includes(canary), false);
        if (option.startsWith("fail"))
          assert.equal(e.message, "ASSIGNMENT_INDETERMINATE");
        return true;
      },
    );
    assert.equal(client.mutations, option.startsWith("fail") ? 1 : 0);
  }
});
test("private pipe rejects invalid, oversize, stalled input and cleans canary buffers", async (t) => {
  const root = await directory(t);
  for (const value of [
    canary + "\n",
    "bad\nextra",
    "x".repeat(513) + "\n",
    "bad\x80\n",
  ]) {
    const budget = await BackupBudget.create({
      roots: [root],
      milliseconds: 200,
    });
    const data = Buffer.from(value),
      stream = Readable.from([data]);
    try {
      if (value === canary + "\n")
        assert.equal(await readPipe(stream, budget), canary);
      else await assert.rejects(readPipe(stream, budget));
    } finally {
      budget.close();
    }
  }
  const budget = await BackupBudget.create({ roots: [root], milliseconds: 30 });
  await assert.rejects(
    readPipe(new Readable({ read() {} }), budget),
    /TOTAL_DEADLINE/,
  );
  budget.close();
});
test("receipt binding and CLI refuse missing approval and cancelled v1", async () => {
  const p = packet(),
    r = {
      status: "ASSIGNED_NOLOGIN",
      role: TARGET.role,
      endUtc: p.endUtc,
      approvalId: p.approvalId,
      sourceRevision: revision,
      administratorClosed: true,
    };
  validateHandoff(r, p);
  for (const delta of [
    { status: "REFUSED" },
    { administratorClosed: false },
    { role: "neondb_owner" },
    { sourceRevision: "b".repeat(40) },
    { approvalId: "old" },
  ])
    assert.throws(
      () => validateHandoff({ ...r, ...delta }, p),
      /HANDOFF_REFUSED/,
    );
  for (const args of [
    [],
    [RUN.replace("v2", "v1") + "/approval.json"],
    ["--host", "parent.invalid"],
  ])
    await assert.rejects(
      execute(process.execPath, [
        "scripts/p06-private-role-password.mjs",
        ...args,
      ]),
      (e) => {
        assert.equal(e.stdout, "HANDOFF_REFUSED\n");
        assert.equal(e.stderr, "");
        return true;
      },
    );
});

test(
  "actual fixed local PG18 restricted-role password proof",
  { skip: process.env.P06_PRIVATE_LOCAL_PROOF !== "1" },
  async (t) => {
    const socket = "/private/tmp/signmons-pg18-YjyVW4/socket";
    assert.equal(await realpath(socket), socket);
    assert.equal((await stat(socket)).mode & 0o777, 0o700);
    const c = new pg.Client({
      host: socket,
      database: "postgres",
      user: "debynyhanbanks",
    });
    await c.connect();
    const root = await directory(t),
      db = "p06_password_fixture";
    let created = false,
      client;
    try {
      assert.equal(
        (await c.query("SHOW listen_addresses")).rows[0].listen_addresses,
        "",
      );
      assert.equal(
        (
          await c.query(
            "SELECT count(*)::int AS n FROM pg_roles WHERE rolname IN ('neondb_owner','p06_migration_runner','p06_migration_owner')",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await c.query(
            "SELECT count(*)::int AS n FROM pg_database WHERE datname='p06_password_fixture'",
          )
        ).rows[0].n,
        0,
      );
      await c.query(
        "CREATE ROLE neondb_owner LOGIN CREATEROLE; CREATE ROLE p06_migration_owner NOLOGIN",
      );
      created = true;
      // Neon administrators inherit pg_monitor, including pg_read_all_settings.
      // This local metadata-only grant models visibility; runner gets no membership.
      await c.query("GRANT pg_read_all_settings TO neondb_owner");
      await c.query(
        "SET ROLE neondb_owner; CREATE ROLE p06_migration_runner NOLOGIN; RESET ROLE",
      );
      await c.query("CREATE DATABASE p06_password_fixture OWNER neondb_owner");
      client = new pg.Client({
        host: socket,
        database: db,
        user: "neondb_owner",
      });
      await client.connect();
      await client.query("CREATE SCHEMA legacy_2025");
      for (const r of TABLES)
        await client.query(
          `CREATE TABLE "${r.schemaname}"."${r.tablename}" (id text PRIMARY KEY)`,
        );
      await client.query(
        "GRANT USAGE ON SCHEMA public,legacy_2025 TO p06_migration_runner; GRANT SELECT ON ALL TABLES IN SCHEMA public,legacy_2025 TO p06_migration_runner",
      );
      const logs = (await client.query(LOGGING_SQL)).rows,
        ext = (
          await client.query(
            "SELECT extname,extversion FROM pg_extension ORDER BY extname",
          )
        ).rows;
      const p = {
        ...packet(),
        loggingFingerprint: loggingFingerprint(logs, ext),
      };
      const budget = await BackupBudget.create({
        roots: [root],
        milliseconds: 10000,
      });
      try {
        assert.equal(
          (await assignCore({ client, budget, packet: p, root, database: db }))
            .status,
          "ASSIGNED_NOLOGIN",
        );
      } finally {
        budget.close();
      }
      const { parsePassfile } = await import("./p06-backup-once.mjs");
      const password = parsePassfile(await readFile(root + "/pgpass", "utf8"));
      // Force password authentication ONLY in this existing disposable local cluster.
      const denied = new pg.Client({
        host: socket,
        database: db,
        user: TARGET.role,
        password,
      });
      await assert.rejects(denied.connect());
      await denied.end();
      await c.query("ALTER ROLE p06_migration_runner LOGIN");
      const reader = new pg.Client({
        host: socket,
        database: db,
        user: TARGET.role,
        password,
      });
      await reader.connect();
      assert.equal(
        (await reader.query("SELECT current_user")).rows[0].current_user,
        TARGET.role,
      );
      await reader.end();
      const wrong = new pg.Client({
        host: socket,
        database: db,
        user: TARGET.role,
        password: "wrong-dummy",
      });
      await assert.rejects(wrong.connect());
      await wrong.end();
      await c.query("ALTER ROLE p06_migration_runner NOLOGIN");
    } finally {
      if (client) await client.end();
      if (created) {
        await c.query("DROP DATABASE IF EXISTS p06_password_fixture");
        await c.query(
          "DROP ROLE p06_migration_runner; DROP ROLE p06_migration_owner; DROP ROLE neondb_owner",
        );
      }
      await c.end();
    }
  },
);
