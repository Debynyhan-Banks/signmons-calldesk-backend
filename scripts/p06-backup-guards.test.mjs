import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  writeFile,
  readFile,
  stat,
  symlink,
  rm,
  chmod,
  realpath,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import {
  BackupBudget,
  compareTables,
  sameMetadata,
} from "./p06_backup_guards.mjs";

const secret = "FICTIONAL_PRIVATE_SENTINEL";
async function fixture(t, limits = {}) {
  const root = await realpath(await mkdtemp("/private/tmp/p06-guard-test-"));
  const budget = await BackupBudget.create({ roots: [root], ...limits });
  t.after(async () => {
    budget.close();
    await rm(root, { recursive: true });
  });
  return { root, budget };
}
const program = (budget, code, options) =>
  budget.command(process.execPath, ["-e", code], options);
const isCode = (code) => (error) =>
  error.message === code &&
  !String(error.stack).includes(secret) &&
  !error.cause;

test("exclusive private archive, exact byte boundary, stderr not retained", async (t) => {
  const { root, budget } = await fixture(t, { archiveBytes: 128 });
  const archive = path.join(root, "source.dump");
  const result = await program(
    budget,
    'process.stderr.write("' +
      secret +
      '");process.stdout.write(Buffer.alloc(128,65))',
    { archive },
  );
  assert.deepEqual(result, { code: 0, bytes: 128 });
  assert.equal((await stat(archive)).mode & 0o777, 0o600);
  assert.equal((await readFile(archive)).length, 128);
  assert.equal(JSON.stringify(result).includes(secret), false);
});
test("archive overflow refuses before excess write, stops later work", async (t) => {
  const { root, budget } = await fixture(t, { archiveBytes: 128 });
  const archive = path.join(root, "source.dump");
  await assert.rejects(
    program(budget, "process.stdout.write(Buffer.alloc(129))", { archive }),
    isCode("ARCHIVE_LIMIT"),
  );
  assert.ok((await stat(archive)).size <= 128);
  await assert.rejects(
    program(budget, "process.exit(0)"),
    isCode("ARCHIVE_LIMIT"),
  );
});
test("existing file and symlink preserved, no overwrite or traversal", async (t) => {
  for (const link of [false, true]) {
    const { root, budget } = await fixture(t);
    const target = path.join(root, "keep");
    await writeFile(target, secret);
    const archive = link ? path.join(root, "link") : target;
    if (link) await symlink(target, archive);
    await assert.rejects(
      program(budget, "process.stdout.write('bad')", { archive }),
      /PROCESS_FAILED|WORKSPACE_OBJECT_REFUSED/,
    );
    assert.equal(await readFile(target, "utf8"), secret);
  }
});
test("insecure workspace and excessive configured limits refused", async (t) => {
  const { root } = await fixture(t);
  await chmod(root, 0o755);
  await assert.rejects(
    BackupBudget.create({ roots: [root] }),
    isCode("PRIVATE_WORKSPACE_REQUIRED"),
  );
  await chmod(root, 0o700);
  await assert.rejects(
    BackupBudget.create({ roots: [root], milliseconds: 1200001 }),
    isCode("INVALID_LIMITS"),
  );
  await assert.rejects(
    BackupBudget.create({ roots: [root], archiveBytes: 67108865 }),
    isCode("INVALID_LIMITS"),
  );
});
test("workspace growth cancels running process; no fresh budget per command", async (t) => {
  const { root, budget } = await fixture(t, { workspaceBytes: 128 });
  const pending = program(budget, "setInterval(()=>{},1000)");
  const refusal = assert.rejects(pending, isCode("WORKSPACE_LIMIT"));
  await writeFile(path.join(root, "growth"), Buffer.alloc(129));
  await refusal;
});
test("aggregate deadline spans successive commands and kills pending work", async (t) => {
  const { budget } = await fixture(t, { milliseconds: 600 });
  await program(budget, "setTimeout(()=>{},100)");
  await assert.rejects(
    program(budget, "setTimeout(()=>{},1000)"),
    isCode("TOTAL_DEADLINE"),
  );
});
test("cancel and nonzero subprocess errors are fixed, payload-free", async (t) => {
  const a = await fixture(t);
  await assert.rejects(
    program(
      a.budget,
      'process.stderr.write("' + secret + '"); process.exit(7)',
    ),
    isCode("PROCESS_FAILED"),
  );
  const b = await fixture(t);
  const pending = program(b.budget, "setInterval(()=>{},1000)");
  const refusal = assert.rejects(pending, isCode("CANCELLED"));
  b.budget.abort();
  await refusal;
});
test("expected failed restore may be inspected without leaking diagnostics", async (t) => {
  const { budget } = await fixture(t);
  assert.deepEqual(
    await program(
      budget,
      'process.stderr.write("' + secret + '");process.exit(1)',
      { expected: 1 },
    ),
    { code: 1, bytes: 0 },
  );
});

test("termination signal aborts the owned process group and cannot renew budget", async (t) => {
  const { root, budget } = await fixture(t);
  const marker = path.join(root, "should-not-exist");
  const pending = program(
    budget,
    "const {spawn}=require('node:child_process');" +
      "spawn(process.execPath,['-e'," +
      JSON.stringify(
        "setTimeout(()=>require('node:fs').writeFileSync(" +
          JSON.stringify(marker) +
          ",'unexpected'),300)",
      ) +
      "],{stdio:'inherit'});setInterval(()=>{},1000)",
  );
  const refusal = assert.rejects(pending, isCode("CANCELLED"));
  await delay(80);
  process.kill(process.pid, "SIGTERM");
  await refusal;
  await delay(350);
  await assert.rejects(stat(marker), { code: "ENOENT" });
  await assert.rejects(program(budget, "process.exit(0)"), isCode("CANCELLED"));
});

function client(values, { badSnapshot = false, queryError = false } = {}) {
  let index = 0;
  return {
    ended: false,
    fetches: 0,
    async end() {
      this.ended = true;
    },
    async query(sql) {
      if (queryError) throw Error(secret);
      if (sql === "SHOW transaction_isolation")
        return {
          rows: [
            {
              transaction_isolation: badSnapshot
                ? "read committed"
                : "repeatable read",
            },
          ],
        };
      if (sql === "SHOW transaction_read_only")
        return { rows: [{ transaction_read_only: "on" }] };
      if (sql.startsWith("DECLARE")) {
        assert.match(sql, /octet_length/);
        assert.match(sql, /COLLATE "C"/);
        index = 0;
      }
      if (sql.startsWith("FETCH")) {
        assert.equal(sql, "FETCH FORWARD 1 FROM p06_rows");
        this.fetches++;
        return {
          rows: index < values.length ? [{ value: values[index++] }] : [],
        };
      }
      return { rows: [] };
    },
  };
}
const tables = [{ schemaname: "legacy_2025", tablename: "Tenant" }];
test("bounded cursor comparison: empty, duplicates and multi-row exact match", async (t) => {
  for (const values of [[], [secret], [secret, secret, "x"]]) {
    const { budget } = await fixture(t);
    const a = client(values),
      b = client(values);
    assert.deepEqual(await compareTables(budget, a, b, tables), {
      tables: 1,
      rows: values.length,
      matched: true,
    });
    assert.equal(a.fetches, values.length + 1);
  }
});
test("row mismatch, missing/extra duplicate, oversize, unsafe inventory and driver failures redact", async (t) => {
  for (const [a, b, code] of [
    [[secret], ["other"], "ROW_MISMATCH"],
    [[secret, secret], [secret], "ROW_MISMATCH"],
    [[], [secret], "ROW_MISMATCH"],
    [[null], [null], "ROW_SIZE_LIMIT"],
  ]) {
    const { budget } = await fixture(t);
    await assert.rejects(
      compareTables(budget, client(a), client(b), tables),
      isCode(code),
    );
  }
  const { budget } = await fixture(t);
  await assert.rejects(
    compareTables(
      budget,
      client([], { badSnapshot: true }),
      client([]),
      tables,
    ),
    isCode("SNAPSHOT_REQUIRED"),
  );
  await assert.rejects(
    compareTables(budget, client([], { queryError: true }), client([]), tables),
    isCode("OPERATION_FAILED"),
  );
  await assert.rejects(
    compareTables(budget, client([]), client([]), [
      { schemaname: secret + '";', tablename: "T" },
    ]),
    isCode("INVENTORY_REFUSED"),
  );
  assert.throws(
    () => sameMetadata({ value: secret }, { value: "x" }),
    isCode("METADATA_MISMATCH"),
  );
});
test("query abort closes its dedicated connection; late error is consumed", async (t) => {
  const { budget } = await fixture(t);
  const c = {
    ended: false,
    query: () =>
      delay(50).then(() => {
        throw Error(secret);
      }),
    async end() {
      this.ended = true;
    },
  };
  const pending = budget.query(c, "not logged");
  const refusal = assert.rejects(pending, isCode("CANCELLED"));
  budget.abort();
  await refusal;
  assert.equal(c.ended, true);
  await delay(70);
});

test("server timeout shrinks with shared budget; pipelining refused", async (t) => {
  const { budget } = await fixture(t, { milliseconds: 2000 });
  const settings = [];
  const c = {
    async end() {},
    async query(sql) {
      if (sql.startsWith("SET statement_timeout")) settings.push(sql);
      return { rows: [] };
    },
  };
  await budget.query(c, "SELECT 1");
  await delay(30);
  await budget.query(c, "SELECT 1");
  const values = settings.map((s) =>
    Number(/statement_timeout='(\d+)ms'/.exec(s)[1]),
  );
  assert.ok(values[1] < values[0]);
  assert.ok(
    settings.every((s) => s.includes("idle_in_transaction_session_timeout")),
  );
  await assert.rejects(
    budget.query({ ...c, pipeline: true }, "SELECT 1"),
    isCode("PIPELINED_CONNECTION_REFUSED"),
  );
});
