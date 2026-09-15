import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  stat,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  TARGET,
  RUN,
  TABLES,
  CATALOG,
  validatePacket,
  privateFile,
  parsePassfile,
  reserveAttempt,
  backupCore,
  cleanupOwned,
  ADMIN_RUN,
  ADMIN_ROLE,
  validateExistingAdminPacket,
  validateSourceFlags,
  writeAdminPassfile,
} from "./p06-backup-once.mjs";
const now = Date.parse("2026-09-15T16:00:00.000Z");
const revision = "a".repeat(40);
const packet = () => ({
  ...TARGET,
  owner: "Debynyhan Banks",
  approvalId: "P06-R02-local-test",
  sourceRevision: revision,
  runDirectory: RUN,
  retentionDays: 7,
  administratorCloseoutAcknowledged: true,
  startUtc: "2026-09-15T16:00:00.000Z",
  endUtc: "2026-09-15T16:20:00.000Z",
  verifiedAtUtc: "2026-09-15T15:59:00.000Z",
  remainingCUh: 1,
  remainingTransferBytes: 134217728,
  noOtherConsumersConfirmed: true,
});
const sentinel = "FICTIONAL_PRIVATE_SENTINEL";
test("live entry point has no circular local module imports before private input", async () => {
  const visiting = new Set(),
    done = new Set();
  async function visit(filename) {
    assert.ok(
      !visiting.has(filename),
      "circular live-entry dependency: " + path.basename(filename),
    );
    if (done.has(filename)) return;
    visiting.add(filename);
    const text = await readFile(filename, "utf8");
    const imports = [
      ...text.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.\/[^"']+\.mjs)["']/g),
    ];
    for (const match of imports)
      await visit(path.resolve(path.dirname(filename), match[1]));
    visiting.delete(filename);
    done.add(filename);
  }
  await visit(path.resolve("scripts/p06-backup-once.mjs"));
});
test("fixed packet and window accepted; no alternate target or expired/unknown allowance", () => {
  assert.equal(validatePacket(packet(), revision, now), 1200000);
  for (const patch of [
    { host: "parent.invalid" },
    { branch: "other" },
    { role: "neondb_owner" },
    { database: "other" },
    { sourceRevision: "b".repeat(40) },
    { runDirectory: "/tmp" },
    { approvalId: "" },
    { administratorCloseoutAcknowledged: false },
    { retentionDays: 30 },
    { startUtc: "2026-09-15T16:01:00.000Z" },
    { endUtc: "2026-09-15T16:00:00.000Z" },
    { endUtc: "2026-09-15T16:20:01.000Z" },
    { verifiedAtUtc: "2026-09-15T15:00:00.000Z" },
    { startUtc: "2026-99-99T16:00:00.000Z" },
    { remainingCUh: 0 },
    { remainingCUh: "1" },
    { remainingTransferBytes: 0 },
    { noOtherConsumersConfirmed: false },
  ])
    assert.throws(() =>
      validatePacket({ ...packet(), ...patch }, revision, now),
    );
});
async function directory(t) {
  const root = await realpath(await mkdtemp("/private/tmp/p06-once-test-"));
  t.after(() => rm(root, { recursive: true }));
  return root;
}
test("scoped passfile parsing and secure file boundary; errors never carry private input", async (t) => {
  const root = await directory(t),
    filename = path.join(root, "pgpass");
  const text =
    [
      TARGET.host,
      "5432",
      TARGET.database,
      TARGET.role,
      "dummy\\:value\\\\x",
    ].join(":") + "\n";
  assert.equal(parsePassfile(text), "dummy:value\\x");
  for (const value of [
    sentinel,
    text + text,
    text.replace(TARGET.role, "neondb_owner"),
    text.replace(TARGET.host, "*"),
    text + "extra",
    text.replace("dummy", "bad\r"),
  ]) {
    assert.throws(
      () => parsePassfile(value),
      (e) =>
        e.message === "PASSFILE_REFUSED" && !String(e.stack).includes(sentinel),
    );
  }
  await writeFile(filename, text, { mode: 0o600 });
  assert.equal((await privateFile(filename, 2048)).data, text);
  await chmod(filename, 0o644);
  await assert.rejects(privateFile(filename, 2048), /PRIVATE_FILE_REFUSED/);
  await chmod(filename, 0o600);
  await symlink(filename, path.join(root, "link"));
  await assert.rejects(privateFile(path.join(root, "link"), 2048));
  await assert.rejects(privateFile(filename, 1), /PRIVATE_FILE_REFUSED/);
});
test("attempt marker is exclusive, durable and private, including concurrent invocation", async (t) => {
  const root = await directory(t);
  const results = await Promise.allSettled([
    reserveAttempt(root, packet()),
    reserveAttempt(root, packet()),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    (await stat(path.join(root, "attempt.json"))).mode & 0o777,
    0o600,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(root, "attempt.json"))).approvalId,
    packet().approvalId,
  );
  await assert.rejects(reserveAttempt(root, packet()));
});
test("CLI without exact packet refuses before any network work", async () => {
  for (const args of [[], ["/tmp/wrong-approval.json"]]) {
    await assert.rejects(
      promisify(execFile)(process.execPath, [
        "scripts/p06-backup-once.mjs",
        ...args,
      ]),
      (e) => e.code === 1 && e.stderr.includes("APPROVAL_PACKET_REQUIRED"),
    );
  }
});
function fakeClient({
  mismatch = false,
  metadataMismatch = false,
  role = "reader",
  history = [],
  failAt = "",
  database = "fixture",
  elevated = false,
} = {}) {
  const queries = [];
  let fetched = false;
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      if (failAt && sql.includes(failAt)) throw new Error(sentinel);
      if (sql.includes("current_database() AS"))
        return {
          rows: [{ database, role, version: 180006, bytes: 1000 }],
        };
      if (sql.startsWith("SELECT rolsuper"))
        return {
          rows: [
            {
              rolsuper: false,
              rolcreatedb: false,
              rolcreaterole: elevated,
              rolreplication: false,
              rolbypassrls: false,
            },
          ],
        };
      if (sql.startsWith("SELECT schemaname,tablename FROM pg_tables"))
        return { rows: TABLES };
      if (sql.includes("FROM public._prisma_migrations"))
        return { rows: history };
      if (sql === "SELECT pg_export_snapshot() AS id")
        return { rows: [{ id: "00000001-00000002-1" }] };
      if (sql === "SHOW transaction_isolation")
        return { rows: [{ transaction_isolation: "repeatable read" }] };
      if (sql === "SHOW transaction_read_only")
        return { rows: [{ transaction_read_only: "on" }] };
      if (CATALOG.includes(sql)) {
        if (sql === CATALOG[0])
          return { rows: [{ nspname: "legacy_2025" }, { nspname: "public" }] };
        return {
          rows:
            metadataMismatch && sql === CATALOG[3]
              ? [{ definition: sentinel }]
              : [],
        };
      }
      if (sql.startsWith("DECLARE")) fetched = false;
      if (sql.startsWith("FETCH")) {
        const rows = fetched
          ? []
          : [{ value: mismatch ? "different" : sentinel }];
        fetched = true;
        return { rows };
      }
      return { rows: [] };
    },
    async end() {},
  };
}
function fakeBudget() {
  return {
    async query(c, sql) {
      try {
        return await c.query(sql);
      } catch {
        throw Error("OPERATION_FAILED");
      }
    },
    async check() {},
  };
}
async function core(options = {}) {
  const source = options.source ?? fakeClient(),
    target = options.target ?? fakeClient();
  const calls = [];
  const result = await backupCore({
    budget: fakeBudget(),
    source,
    target,
    database: options.existingAdmin ? TARGET.database : "fixture",
    role: options.existingAdmin ? ADMIN_ROLE : "reader",
    existingAdmin: options.existingAdmin ?? false,
    history: [],
    archive: "not-written",
    async dump() {
      calls.push("dump");
      if (options.dumpFailure) throw Error("PROCESS_FAILED");
    },
    async restore() {
      calls.push("restore");
      if (options.restoreFailure) throw Error("PROCESS_FAILED");
    },
  });
  return { result, calls, source };
}
test("same core executes one snapshot/dump/restore and only read-only source statements", async () => {
  const { result, calls, source } = await core();
  assert.deepEqual(calls, ["dump", "restore"]);
  const { dumpCompletedUtc, ...counts } = result;
  assert.ok(Number.isFinite(Date.parse(dumpCompletedUtc)));
  assert.deepEqual(counts, { tables: 26, rows: 26, matched: true });
  assert.ok(
    source.queries.every((q) =>
      /^(BEGIN|SELECT|LOCK|SHOW|SET|DECLARE|FETCH|CLOSE|ROLLBACK)/.test(q),
    ),
  );
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});
test("existing administrator exception is explicit and cannot override target, window or old packet", () => {
  const p = {
    ...packet(),
    role: ADMIN_ROLE,
    runDirectory: ADMIN_RUN,
    existingAdministratorBackupApproved: true,
    inheritedCredentialRiskAcknowledged: true,
  };
  assert.equal(validateExistingAdminPacket(p, revision, now), 1200000);
  assert.throws(() => validatePacket(p, revision, now));
  for (const patch of [
    { host: "parent.invalid" },
    { role: TARGET.role },
    { runDirectory: RUN },
    { existingAdministratorBackupApproved: false },
    { inheritedCredentialRiskAcknowledged: false },
    { endUtc: p.startUtc },
    { remainingCUh: 0 },
    { sourceRevision: "b".repeat(40) },
  ])
    assert.throws(() =>
      validateExistingAdminPacket({ ...p, ...patch }, revision, now),
    );
  assert.throws(() => validateExistingAdminPacket(packet(), revision, now));
});
test("administrator flags are allowed only under exact exception, never actual superuser", () => {
  const flags = {
    rolsuper: false,
    rolcreatedb: true,
    rolcreaterole: true,
    rolreplication: true,
    rolbypassrls: true,
  };
  validateSourceFlags(flags, ADMIN_ROLE, TARGET.database, true);
  for (const [f, r, d, a] of [
    [flags, ADMIN_ROLE, TARGET.database, false],
    [flags, "other", TARGET.database, true],
    [flags, ADMIN_ROLE, "other", true],
    [{ ...flags, rolsuper: true }, ADMIN_ROLE, TARGET.database, true],
    [{ rolsuper: false }, ADMIN_ROLE, TARGET.database, true],
  ])
    assert.throws(() => validateSourceFlags(f, r, d, a));
});
test("administrator passfile is exclusive, escaped, private and removable without changing credential", async (t) => {
  const root = await directory(t),
    secret = "FICTIONAL:admin\\canary";
  const identity = await writeAdminPassfile(root, secret);
  const pass = await privateFile(root + "/pgpass", 2048);
  assert.equal(pass.ino, identity.ino);
  assert.equal(parsePassfile(pass.data, ADMIN_ROLE), secret);
  assert.throws(() => parsePassfile(pass.data));
  await assert.rejects(writeAdminPassfile(root, secret));
  const { removeRunner } = await import("./p06-private-role-password.mjs");
  await removeRunner(root, identity);
  await assert.rejects(stat(root + "/pgpass"), { code: "ENOENT" });
  await chmod(root, 0o755);
  await assert.rejects(
    writeAdminPassfile(root, secret),
    /PRIVATE_PATH_REFUSED/,
  );
});
test("existing admin core preserves full comparison and only read-only source SQL; mismatches stop", async () => {
  const source = fakeClient({
    role: ADMIN_ROLE,
    database: TARGET.database,
    elevated: true,
  });
  const { result, calls } = await core({ source, existingAdmin: true });
  assert.equal(result.matched, true);
  assert.deepEqual(calls, ["dump", "restore"]);
  assert.ok(
    source.queries.every((q) =>
      /^(BEGIN|SELECT|LOCK|SHOW|SET|DECLARE|FETCH|CLOSE|ROLLBACK)/.test(q),
    ),
  );
  assert.ok(source.queries[0].endsWith("READ ONLY"));
  await assert.rejects(
    core({
      source: fakeClient({
        role: ADMIN_ROLE,
        database: "parent",
        elevated: true,
      }),
      existingAdmin: true,
    }),
  );
  await assert.rejects(
    core({
      source: fakeClient({
        role: ADMIN_ROLE,
        database: TARGET.database,
        elevated: true,
      }),
      existingAdmin: true,
      target: fakeClient({ mismatch: true }),
    }),
  );
});
test("identity, history, source IO, dump, restore, legacy metadata and row failure refuse", async () => {
  const cases = [
    { source: fakeClient({ role: "neondb_owner" }) },
    { source: fakeClient({ history: [{ checksum: sentinel }] }) },
    { source: fakeClient({ failAt: "pg_export_snapshot" }) },
    { dumpFailure: true },
    { restoreFailure: true },
    { target: fakeClient({ metadataMismatch: true }) },
    { target: fakeClient({ mismatch: true }) },
  ];
  for (const options of cases)
    await assert.rejects(
      core(options),
      (e) => !String(e.stack).includes(sentinel),
    );
});
test("cleanup attempts remaining steps on failures but never ejects a running server", async () => {
  for (const stage of ["none", "connection", "server", "passfile", "image"]) {
    const calls = [];
    const action = (name) => async () => {
      calls.push(name);
      if (stage === name) throw Error(sentinel);
    };
    const operation = cleanupOwned({
      clients: [{ end: action("connection") }],
      stop: action("server"),
      removePassfile: action("passfile"),
      eject: action("image"),
    });
    if (stage === "none") await operation;
    else
      await assert.rejects(
        operation,
        (e) =>
          e.message === "CLEANUP_FAILED" && !String(e.stack).includes(sentinel),
      );
    assert.ok(calls.includes("passfile"));
    assert.equal(calls.includes("image"), stage !== "server");
  }
});
