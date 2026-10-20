// Inert maintenance runner. No CLI, live target, credentials, approval or scheduler.
// A separately approved private entry must pin reviewedPlanHash and provide the connector.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { readPipe } from "./p06_backup_guards.mjs";
const digest = (v) => createHash("sha256").update(v).digest("hex");
const keys = (v, k) =>
  assert.deepEqual(Object.keys(v).sort(), k.split(",").sort());
export const planHash = (p) => digest(JSON.stringify(p));
export async function runCleanup({
  plan,
  authorization,
  reviewedPlanHash,
  sourceRoot,
  journalRoot,
  input,
  ready,
  connect,
  now = Date.now,
}) {
  let connection,
    password,
    attempted = false,
    completed = 0;
  const save = async (name, value) => {
    const f = await open(path.join(journalRoot, name + ".json"), "wx", 0o600);
    try {
      await f.writeFile(JSON.stringify(value) + "\n");
      await f.sync();
    } finally {
      await f.close();
    }
  };
  try {
    plan = structuredClone(plan);
    authorization = structuredClone(authorization);
    assert.equal(planHash(plan), reviewedPlanHash);
    keys(plan, "binding,target,sourceHashes");
    assert.equal(plan.binding.mode, "EXACT_SESSION_MAINTENANCE_V1");
    keys(
      authorization,
      "decision,action,operationId,approvalId,planHash,automaticRetryAllowed,deploymentAllowed",
    );
    assert.deepEqual(authorization, {
      decision: "APPROVED",
      action: "THREE_EXPIRED_SESSION_CLEANUP",
      operationId: plan.binding.operationId,
      approvalId: plan.binding.approvalId,
      planHash: reviewedPlanHash,
      automaticRetryAllowed: false,
      deploymentAllowed: false,
    });
    assert.ok(
      Number.isSafeInteger(now()) &&
        now() >= plan.binding.validFrom &&
        now() + 300000 < plan.binding.validUntil,
    );
    assert.ok(
      Array.isArray(plan.binding.targets) && plan.binding.targets.length === 3,
    );
    const required = [
      "src/communications/verification-cleanup.service.ts",
      "dist/communications/verification-cleanup.service.js",
      "scripts/p06-cleanup-maintenance.mjs",
      "scripts/p06-cleanup-connector.mjs",
      "scripts/p06_backup_guards.mjs",
      "package-lock.json",
      "prisma/schema.prisma",
    ];
    assert.ok(required.every((n) => Object.hasOwn(plan.sourceHashes, n)));
    for (const [name, hash] of Object.entries(plan.sourceHashes)) {
      assert.ok(!path.isAbsolute(name) && !name.split("/").includes(".."));
      const file = path.join(sourceRoot, name);
      assert.equal(await realpath(file), file);
      assert.ok((await lstat(file)).isFile());
      assert.equal(digest(await readFile(file)), hash);
    }
    assert.equal(await realpath(journalRoot), journalRoot);
    const stat = await lstat(journalRoot);
    assert.ok(stat.isDirectory());
    assert.equal(stat.mode & 0o777, 0o700);
    assert.equal(stat.uid, process.getuid());
    await save("attempt", {
      operationId: plan.binding.operationId,
      status: "CONSUMED_DO_NOT_RETRY",
      planHash: reviewedPlanHash,
    });
    attempted = true;
    ready();
    password = await readPipe(input, {
      race: async (promise) => {
        let timer;
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(Error("PRIVATE_INPUT_TIMEOUT")),
                60000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
    });
    assert.ok(now() + 240000 < plan.binding.validUntil);
    connection = await connect({
      password,
      target: plan.target,
      binding: plan.binding,
    });
    password = undefined;
    const check = async () => {
      const v = await connection.preflight();
      assert.deepEqual(v, {
        targetHash: digest(JSON.stringify(plan.target)),
        postgresMajor: 18,
        phoneEnabled: false,
        runtimeEnabled: false,
        canLogin: false,
        connectionLimit: 0,
        expired: true,
        sessionCount: 0,
      });
      assert.ok(
        now() >= plan.binding.validFrom && now() < plan.binding.validUntil,
      );
    };
    await check();
    assert.deepEqual(await connection.service.inspectMaintenance(), {
      eligible: 3,
    });
    for (const target of plan.binding.targets) {
      await check();
      // Journal the target ordinal before a possibly committing call. No private identifiers in output.
      await save("target-" + (completed + 1), {
        ordinal: completed + 1,
        status: "ATTEMPTED",
      });
      const receipt = await connection.service.maintain({
        conversationId: target.conversationId,
        sessionId: target.sessionId,
      });
      assert.deepEqual(receipt, {
        state: "CLOSED",
        cleanupPending: false,
        deliveryAuthorized: false,
      });
      completed++;
    }
    await check();
    const verification = await connection.verifyUnchangedAndClosed();
    assert.deepEqual(verification, {
      closed: 3,
      purged: 3,
      jobsUnchanged: true,
      holdsUnchanged: true,
      operationsUnchanged: true,
      aliasesUnchanged: true,
      businessRecordsPreserved: true,
    });
    await connection.close();
    connection = undefined;
    const result = {
      status: "CLEANUP_VERIFIED",
      completed,
      automaticRetryAllowed: false,
    };
    await save("result", result);
    return result;
  } catch {
    if (attempted) {
      try {
        await save("stop", {
          status: "UNCONFIRMED_DO_NOT_RETRY",
          completed,
          automaticRetryAllowed: false,
        });
      } catch {}
    }
    return {
      status: attempted ? "UNCONFIRMED_DO_NOT_RETRY" : "REFUSED_NO_ACTION",
      completed,
      automaticRetryAllowed: false,
    };
  } finally {
    password = undefined;
    if (connection) {
      try {
        await connection.close();
      } catch {
        /* Fixed uncertain result only; never expose driver errors. */
      }
    }
  }
}
