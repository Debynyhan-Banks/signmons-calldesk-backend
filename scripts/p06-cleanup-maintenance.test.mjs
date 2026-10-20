import { test } from "node:test";
import assert from "node:assert/strict";
import {
  realpath,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, PassThrough } from "node:stream";
import { runCleanup, planHash } from "./p06-cleanup-maintenance.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
async function fixture(fn) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "p06-maintenance-")),
  );
  try {
    const journal = path.join(root, "journal");
    await mkdir(journal, { mode: 0o700 });
    const names = [
      "src/communications/verification-cleanup.service.ts",
      "dist/communications/verification-cleanup.service.js",
      "scripts/p06-cleanup-maintenance.mjs",
      "scripts/p06-cleanup-connector.mjs",
      "scripts/p06_backup_guards.mjs",
      "package-lock.json",
      "prisma/schema.prisma",
    ];
    for (const n of names) {
      await mkdir(path.dirname(path.join(root, n)), { recursive: true });
      await writeFile(path.join(root, n), "fixture");
    }
    const plan = {
      binding: {
        mode: "EXACT_SESSION_MAINTENANCE_V1",
        operationId: "fixture-operation",
        approvalId: "fixture-approval",
        validFrom: 1,
        validUntil: 900000,
        targets: [1, 2, 3].map((n) => ({
          conversationId: "c" + n,
          sessionId: "s" + n,
        })),
      },
      target: { database: "synthetic" },
      sourceHashes: Object.fromEntries(names.map((n) => [n, hash("fixture")])),
    };
    const authorization = {
      decision: "APPROVED",
      action: "THREE_EXPIRED_SESSION_CLEANUP",
      operationId: plan.binding.operationId,
      approvalId: plan.binding.approvalId,
      planHash: planHash(plan),
      automaticRetryAllowed: false,
      deploymentAllowed: false,
    };
    let called = 0,
      closed = 0,
      ready = 0;
    const connection = {
      preflight: async () => ({
        targetHash: hash(JSON.stringify(plan.target)),
        postgresMajor: 18,
        phoneEnabled: false,
        runtimeEnabled: false,
        canLogin: false,
        connectionLimit: 0,
        expired: true,
        sessionCount: 0,
      }),
      service: {
        inspectMaintenance: async () => ({ eligible: 3 }),
        maintain: async () => {
          called++;
          return {
            state: "CLOSED",
            cleanupPending: false,
            deliveryAuthorized: false,
          };
        },
      },
      verifyUnchangedAndClosed: async () => ({
        closed: 3,
        purged: 3,
        jobsUnchanged: true,
        holdsUnchanged: true,
        operationsUnchanged: true,
        aliasesUnchanged: true,
        businessRecordsPreserved: true,
      }),
      close: async () => {
        closed++;
      },
    };
    const args = {
      plan,
      authorization,
      reviewedPlanHash: planHash(plan),
      sourceRoot: root,
      journalRoot: journal,
      input: Readable.from([Buffer.from("synthetic-password\n")]),
      ready: () => {
        ready++;
      },
      connect: async ({ password }) => {
        assert.equal(password, "synthetic-password");
        return connection;
      },
      now: () => 1000,
    };
    await fn({
      args,
      connection,
      journal,
      counts: () => ({ called, closed, ready }),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("one run validates and closes all three; consumed journal refuses", () =>
  fixture(async ({ args, journal, counts }) => {
    assert.equal((await runCleanup(args)).status, "CLEANUP_VERIFIED");
    assert.deepEqual(counts(), { called: 3, closed: 1, ready: 1 });
    assert.equal(
      (
        await runCleanup({
          ...args,
          input: Readable.from(["synthetic-password\n"]),
        })
      ).status,
      "REFUSED_NO_ACTION",
    );
    assert.equal(counts().called, 3);
    assert.equal(
      (await readFile(path.join(journal, "result.json"), "utf8")).includes(
        "password",
      ),
      false,
    );
  }));
for (const kind of ["plan", "approval", "source", "expired", "early"])
  test(kind + " mismatch refuses before private input", () =>
    fixture(async ({ args, counts }) => {
      if (kind === "plan") args.plan.target.database = "changed";
      if (kind === "approval") args.authorization.decision = "PENDING";
      if (kind === "source")
        await writeFile(
          path.join(args.sourceRoot, "package-lock.json"),
          "changed",
        );
      if (kind === "expired") args.now = () => 900001;
      if (kind === "early") args.now = () => 0;
      assert.equal((await runCleanup(args)).status, "REFUSED_NO_ACTION");
      assert.equal(counts().ready, 0);
      assert.equal(counts().called, 0);
    }),
  );
test("active runtime refuses before cleanup and closes connection", () =>
  fixture(async ({ args, connection, counts }) => {
    const old = connection.preflight;
    connection.preflight = async () => ({ ...(await old()), canLogin: true });
    assert.equal((await runCleanup(args)).status, "UNCONFIRMED_DO_NOT_RETRY");
    assert.equal(counts().called, 0);
    assert.equal(counts().closed, 1);
  }));
test("purge pending stops after first ordinal; no driver text leaks", () =>
  fixture(async ({ args, connection, journal, counts }) => {
    connection.service.maintain = async () => ({
      state: "CLOSED",
      cleanupPending: true,
      deliveryAuthorized: false,
    });
    const r = await runCleanup(args);
    assert.equal(r.status, "UNCONFIRMED_DO_NOT_RETRY");
    assert.equal(r.completed, 0);
    assert.equal(counts().closed, 1);
    await assert.rejects(readFile(path.join(journal, "target-2.json")));
  }));
test("ambiguous write stops without retry and closes", () =>
  fixture(async ({ args, connection, counts }) => {
    let calls = 0;
    connection.service.maintain = async () => {
      calls++;
      throw Error("private driver secret");
    };
    const r = await runCleanup(args);
    assert.equal(r.status, "UNCONFIRMED_DO_NOT_RETRY");
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(r).includes("secret"));
    assert.equal(counts().closed, 1);
  }));
test("failed final fingerprints cannot report success", () =>
  fixture(async ({ args, connection }) => {
    connection.verifyUnchangedAndClosed = async () => ({
      holdsUnchanged: false,
    });
    assert.equal((await runCleanup(args)).status, "UNCONFIRMED_DO_NOT_RETRY");
  }));
test("malformed private input never connects", () =>
  fixture(async ({ args, counts }) => {
    args.input = Readable.from(["bad\nextra\n"]);
    args.connect = () => {
      throw Error("must not connect");
    };
    assert.equal((await runCleanup(args)).status, "UNCONFIRMED_DO_NOT_RETRY");
    assert.equal(counts().called, 0);
  }));
test("connection close failure cannot report success or expose error", () =>
  fixture(async ({ args, connection }) => {
    connection.close = async () => {
      throw Error("private close error");
    };
    assert.equal((await runCleanup(args)).status, "UNCONFIRMED_DO_NOT_RETRY");
  }));

test("private-input deadline consumes attempt without connection or cleanup", async (t) =>
  fixture(async ({ args, counts }) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    const ready = new Promise((resolve) => {
      signal = resolve;
    });
    args.ready = () => signal();
    args.input = new PassThrough();
    let connects = 0;
    args.connect = async () => {
      connects++;
      throw Error("must not connect");
    };
    const running = runCleanup(args);
    await ready;
    t.mock.timers.tick(60001);
    assert.equal((await running).status, "UNCONFIRMED_DO_NOT_RETRY");
    assert.equal(connects, 0);
    assert.equal(counts().called, 0);
    t.mock.timers.reset();
  }));
