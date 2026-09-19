import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  R10ControllerStop,
  closeR10Runtime,
  executeR10ActivateBeforeDeploy,
  requireR10CloseoutWindow,
  requireR10ExecutionWindow,
  reserveR10Operation,
  reviewR10ControllerPlan,
} from "./p06-r10-controller.mjs";

const START = Date.parse("2026-09-20T01:00:00.000Z");
const plan = (overrides = {}) => ({
  planId: "11111111-1111-4111-8111-111111111111",
  packetDigest: "1".repeat(64),
  runtimeDigest: "2".repeat(64),
  phoneDigest: "3".repeat(64),
  revision: "signmons-calldesk-staging-app013p06enabled2",
  tag: "p06-intake-enabled",
  origin:
    "https://p06-intake-enabled---signmons-calldesk-staging-p572d6wipq-ul.a.run.app",
  runtimeStart: new Date(START).toISOString(),
  runtimeEnd: new Date(START + 15 * 60_000).toISOString(),
  closeoutEnd: new Date(START + 30 * 60_000).toISOString(),
  ...overrides,
});

const makePorts = (options = {}) => {
  const calls = [];
  const hit = async (name, result) => {
    calls.push(name);
    if (options.throwAt === name) throw Error("synthetic private detail");
    return typeof result === "function" ? result() : result;
  };
  const p = plan();
  const ports = {
    preflight: () =>
      hit("preflight", {
        targetAbsent: true,
        targetTagPresent: false,
        approvalState: "INACTIVE",
        runtimeRoleLogin: true,
        runtimeRoleSessions: 0,
        normalTrafficRevision: "signmons-calldesk-staging-app013bounds",
        normalTrafficPercent: 100,
      }),
    reserveActivation: () => hit("reserveActivation"),
    refreshActivationSnapshot: () =>
      hit("refreshActivationSnapshot", { snapshot: "synthetic" }),
    activate: (_plan, snapshot) => {
      assert.deepEqual(snapshot, { snapshot: "synthetic" });
      assert.equal(Object.isFrozen(snapshot), true);
      return hit("activate");
    },
    readActivation: () =>
      hit("readActivation", {
        state: options.activationReadback ?? "ACTIVE",
        runtimeDigest: p.runtimeDigest,
        phoneDigest: p.phoneDigest,
      }),
    reserveDeployment: () => hit("reserveDeployment"),
    deployNoTraffic: () => hit("deployNoTraffic"),
    readDeployment: () =>
      hit("readDeployment", {
        status: options.deploymentStatus ?? "READY_NO_TRAFFIC",
        revision: p.revision,
        tag: p.tag,
        origin: p.origin,
        normalTrafficRevision: "signmons-calldesk-staging-app013bounds",
        normalTrafficPercent: 100,
        targetTrafficPercent: 0,
      }),
    inspectApproval: () =>
      hit("inspectApproval", {
        state: options.approvalState ?? "ACTIVE",
        runtimeDigest: p.runtimeDigest,
        phoneDigest: p.phoneDigest,
      }),
    reserveRevocation: () => hit("reserveRevocation"),
    revoke: () => hit("revoke"),
    readRevocation: () =>
      hit("readRevocation", {
        state: options.revocationState ?? "REVOKED",
        runtimeDigest: p.runtimeDigest,
        phoneDigest: p.phoneDigest,
      }),
    removeEnabledTag: () => hit("removeEnabledTag"),
    disableRuntimeRole: () => hit("disableRuntimeRole"),
    readClosedState: () =>
      hit("readClosedState", {
        approvalState: options.finalApprovalState ?? "INACTIVE",
        tagPresent: options.finalTagPresent ?? false,
        runtimeRoleLogin: options.finalRuntimeRoleLogin ?? false,
        runtimeRoleConnectionLimit:
          options.finalRuntimeRoleConnectionLimit ?? 0,
        runtimeRoleSessions: options.finalRuntimeRoleSessions ?? 0,
        normalTrafficRevision: "signmons-calldesk-staging-app013bounds",
        normalTrafficPercent: 100,
      }),
  };
  return { calls, ports };
};

test("fresh bounded plan is accepted and consumed plan/revision are refused", () => {
  const reviewed = reviewR10ControllerPlan(plan());
  assert.equal(reviewed.revision.endsWith("enabled2"), true);
  assert.deepEqual(Object.keys(reviewed).sort(), Object.keys(plan()).sort());
  assert.throws(
    () =>
      reviewR10ControllerPlan(
        plan({ planId: "b228f87a-ed6e-4253-a62a-b33128bb094a" }),
      ),
    (error) => error instanceof R10ControllerStop && error.stage === "PLAN",
  );
  assert.throws(
    () =>
      reviewR10ControllerPlan(
        plan({ revision: "signmons-calldesk-staging-app013p06enabled" }),
      ),
    (error) => error instanceof R10ControllerStop && error.stage === "PLAN",
  );
});

test("invalid or misaligned windows fail closed", () => {
  assert.throws(() =>
    reviewR10ControllerPlan(
      plan({ runtimeEnd: new Date(START + 15 * 60_000 + 1).toISOString() }),
    ),
  );
  assert.throws(() => requireR10ExecutionWindow(plan(), START - 1));
  assert.throws(() =>
    requireR10ExecutionWindow(plan(), START + 12 * 60_000, 4 * 60_000),
  );
  assert.throws(() => requireR10CloseoutWindow(plan(), START + 30 * 60_000));
  assert.throws(() =>
    reviewR10ControllerPlan(
      plan({ closeoutEnd: new Date(START + 14 * 60_000).toISOString() }),
    ),
  );
});

test("exclusive reservation is mode 0600 and refuses reuse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p06-r10-controller-"));
  const path = join(directory, "attempt.json");
  const record = {
    operation: "ACTIVATE",
    planId: plan().planId,
    packetDigest: plan().packetDigest,
    reservedAt: new Date(START).toISOString(),
  };
  await reserveR10Operation(path, record);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), record);
  await assert.rejects(reserveR10Operation(path, record), { code: "EEXIST" });
});

test("success activates and reads back before one no-traffic deployment", async () => {
  const { calls, ports } = makePorts();
  const result = await executeR10ActivateBeforeDeploy(
    reviewR10ControllerPlan(plan()),
    ports,
    START,
    0,
  );
  assert.equal(result.status, "READY_FOR_R11");
  assert.deepEqual(calls, [
    "preflight",
    "reserveActivation",
    "refreshActivationSnapshot",
    "activate",
    "readActivation",
    "reserveDeployment",
    "deployNoTraffic",
    "readDeployment",
  ]);
});

test("activation readback mismatch closes without deploying", async () => {
  const { calls, ports } = makePorts({ activationReadback: "INACTIVE" });
  await assert.rejects(executeR10ActivateBeforeDeploy(plan(), ports, START, 0));
  assert.equal(calls.includes("deployNoTraffic"), false);
  assert.ok(calls.indexOf("revoke") < calls.indexOf("removeEnabledTag"));
});

test("deployment readback mismatch closes without a second deployment", async () => {
  const { calls, ports } = makePorts({ deploymentStatus: "NOT_READY" });
  await assert.rejects(executeR10ActivateBeforeDeploy(plan(), ports, START, 0));
  assert.equal(calls.filter((name) => name === "deployNoTraffic").length, 1);
  assert.ok(calls.indexOf("revoke") < calls.indexOf("removeEnabledTag"));
});

for (const stage of [
  "refreshActivationSnapshot",
  "activate",
  "readActivation",
  "reserveDeployment",
  "deployNoTraffic",
  "readDeployment",
]) {
  test(`${stage} stop revokes before tag and role closeout without retry`, async () => {
    const { calls, ports } = makePorts({ throwAt: stage });
    await assert.rejects(
      executeR10ActivateBeforeDeploy(plan(), ports, START, 0),
      (error) =>
        error instanceof R10ControllerStop &&
        error.closeoutStatus === "CLOSED" &&
        !error.message.includes("synthetic private detail"),
    );
    assert.equal(calls.filter((name) => name === stage).length, 1);
    const revoke = calls.indexOf("revoke");
    assert.ok(revoke >= 0);
    assert.ok(revoke < calls.indexOf("removeEnabledTag"));
    assert.ok(
      calls.indexOf("removeEnabledTag") < calls.indexOf("disableRuntimeRole"),
    );
    assert.equal(
      calls.filter((name) => name === "deployNoTraffic").length <= 1,
      true,
    );
    assert.equal(calls.filter((name) => name === "activate").length <= 1, true);
  });
}

test("confirmed inactive activation failure skips revoke and still closes runtime", async () => {
  const { calls, ports } = makePorts({
    throwAt: "activate",
    approvalState: "INACTIVE",
  });
  await assert.rejects(executeR10ActivateBeforeDeploy(plan(), ports, START, 0));
  assert.equal(calls.includes("revoke"), false);
  assert.ok(
    calls.indexOf("removeEnabledTag") < calls.indexOf("disableRuntimeRole"),
  );
});

test("unknown approval is never revoked or guessed and remains unconfirmed", async () => {
  const { calls, ports } = makePorts({
    throwAt: "activate",
    approvalState: "UNKNOWN",
    finalApprovalState: "UNKNOWN",
  });
  await assert.rejects(
    executeR10ActivateBeforeDeploy(plan(), ports, START, 0),
    (error) =>
      error instanceof R10ControllerStop &&
      error.closeoutStatus === "UNCONFIRMED",
  );
  assert.equal(calls.includes("revoke"), false);
  assert.equal(calls.includes("removeEnabledTag"), true);
  assert.equal(calls.includes("disableRuntimeRole"), true);
});

for (const stage of [
  "reserveRevocation",
  "revoke",
  "readRevocation",
  "removeEnabledTag",
  "disableRuntimeRole",
  "readClosedState",
]) {
  test(`${stage} ambiguity is not retried and final readback decides closeout`, async () => {
    const { calls, ports } = makePorts({
      throwAt: stage,
      finalApprovalState:
        stage === "reserveRevocation" ? "UNKNOWN" : "INACTIVE",
      finalTagPresent: stage === "removeEnabledTag" ? true : false,
      finalRuntimeRoleLogin: stage === "disableRuntimeRole" ? true : false,
    });
    const result = await closeR10Runtime(plan(), ports, START);
    assert.equal(calls.filter((name) => name === stage).length, 1);
    assert.equal(
      result.status,
      ["removeEnabledTag", "disableRuntimeRole", "readClosedState"].includes(
        stage,
      ) || stage === "reserveRevocation"
        ? "UNCONFIRMED"
        : "CLOSED",
    );
  });
}

test("explicit closeout skips revoke when approval is already inactive", async () => {
  const { calls, ports } = makePorts({ approvalState: "INACTIVE" });
  const result = await closeR10Runtime(
    reviewR10ControllerPlan(plan()),
    ports,
    START,
  );
  assert.equal(result.status, "CLOSED");
  assert.equal(calls.includes("reserveRevocation"), false);
  assert.equal(calls.includes("revoke"), false);
  assert.deepEqual(calls, [
    "inspectApproval",
    "removeEnabledTag",
    "disableRuntimeRole",
    "readClosedState",
  ]);
});

test("preflight mismatch performs containment and never activates", async () => {
  const { calls, ports } = makePorts({ approvalState: "INACTIVE" });
  ports.preflight = async () => ({ targetAbsent: false });
  await assert.rejects(executeR10ActivateBeforeDeploy(plan(), ports, START, 0));
  assert.equal(calls.includes("activate"), false);
  assert.equal(calls.includes("deployNoTraffic"), false);
  assert.equal(calls.includes("disableRuntimeRole"), true);
});
