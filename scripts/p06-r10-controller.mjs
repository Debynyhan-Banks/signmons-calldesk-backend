import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { dirname } from "node:path";

const CONSUMED_PLAN_ID = "b228f87a-ed6e-4253-a62a-b33128bb094a";
const CONSUMED_REVISION = "signmons-calldesk-staging-app013p06enabled";
const NORMAL_REVISION = "signmons-calldesk-staging-app013bounds";
const TARGET_TAG = "p06-intake-enabled";
const TARGET_ORIGIN =
  "https://p06-intake-enabled---signmons-calldesk-staging-p572d6wipq-ul.a.run.app";
const exactKeys = (value, keys) =>
  Object.keys(value).sort().join() === [...keys].sort().join();
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const digest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const instant = (value) => {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  assert.ok(Number.isSafeInteger(time));
  assert.equal(new Date(time).toISOString(), value);
  return time;
};

export class R10ControllerStop extends Error {
  constructor(stage, closeoutStatus) {
    super("R10 controller stopped.");
    this.name = "R10ControllerStop";
    this.code = "R10_CONTROLLER_STOPPED";
    this.stage = stage;
    this.closeoutStatus = closeoutStatus;
  }
}

export function reviewR10ControllerPlan(input) {
  try {
    const plan = object(input);
    assert.ok(plan);
    assert.ok(
      exactKeys(plan, [
        "planId",
        "packetDigest",
        "runtimeDigest",
        "phoneDigest",
        "revision",
        "tag",
        "origin",
        "runtimeStart",
        "runtimeEnd",
        "closeoutEnd",
      ]),
    );
    assert.ok(uuid(plan.planId));
    assert.notEqual(plan.planId, CONSUMED_PLAN_ID);
    assert.ok(digest(plan.packetDigest));
    assert.ok(digest(plan.runtimeDigest));
    assert.ok(digest(plan.phoneDigest));
    assert.match(
      plan.revision,
      /^signmons-calldesk-staging-app013p06enabled[a-z0-9-]{1,24}$/,
    );
    assert.notEqual(plan.revision, CONSUMED_REVISION);
    assert.equal(plan.tag, TARGET_TAG);
    assert.equal(plan.origin, TARGET_ORIGIN);
    const start = instant(plan.runtimeStart);
    const end = instant(plan.runtimeEnd);
    const closeoutEnd = instant(plan.closeoutEnd);
    assert.ok(start < end && end < closeoutEnd);
    assert.ok(end - start <= 15 * 60_000);
    assert.ok(closeoutEnd - end <= 15 * 60_000);
    return Object.freeze({ ...plan, start, end, closeoutEndMs: closeoutEnd });
  } catch {
    throw new R10ControllerStop("PLAN", "NOT_STARTED");
  }
}

export function requireR10ExecutionWindow(
  input,
  now = Date.now(),
  reserveMs = 0,
) {
  const plan = reviewR10ControllerPlan(input);
  try {
    assert.ok(Number.isSafeInteger(now));
    assert.ok(Number.isSafeInteger(reserveMs) && reserveMs >= 0);
    assert.ok(now >= plan.start && now + reserveMs < plan.end);
    return plan;
  } catch {
    throw new R10ControllerStop("EXECUTION_WINDOW", "NOT_STARTED");
  }
}

export function requireR10CloseoutWindow(input, now = Date.now()) {
  const plan = reviewR10ControllerPlan(input);
  try {
    assert.ok(Number.isSafeInteger(now));
    assert.ok(now >= plan.start && now < plan.closeoutEndMs);
    return plan;
  } catch {
    throw new R10ControllerStop("CLOSEOUT_WINDOW", "UNCONFIRMED");
  }
}

export async function reserveR10Operation(path, record) {
  assert.equal(typeof path, "string");
  assert.ok(path.startsWith("/"));
  const value = object(record);
  assert.ok(
    value &&
      exactKeys(value, ["operation", "planId", "packetDigest", "reservedAt"]),
  );
  assert.match(value.operation, /^[A-Z_]{3,40}$/);
  assert.ok(uuid(value.planId));
  assert.ok(digest(value.packetDigest));
  instant(value.reservedAt);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return Object.freeze({ ...value });
}

const requirePorts = (ports, names) => {
  const value = object(ports);
  assert.ok(value);
  for (const name of names) assert.equal(typeof value[name], "function");
  return value;
};
const active = (state, plan) =>
  object(state)?.state === "ACTIVE" &&
  state.runtimeDigest === plan.runtimeDigest &&
  state.phoneDigest === plan.phoneDigest;
const inactive = (state) => object(state)?.state === "INACTIVE";
const revoked = (state, plan) =>
  object(state)?.state === "REVOKED" &&
  state.runtimeDigest === plan.runtimeDigest &&
  state.phoneDigest === plan.phoneDigest;
const ready = (state, plan) =>
  object(state)?.status === "READY_NO_TRAFFIC" &&
  state.revision === plan.revision &&
  state.tag === plan.tag &&
  state.origin === plan.origin &&
  state.normalTrafficRevision === NORMAL_REVISION &&
  state.normalTrafficPercent === 100 &&
  state.targetTrafficPercent === 0;
const closed = (state) =>
  object(state)?.approvalState === "INACTIVE" &&
  state.tagPresent === false &&
  state.runtimeRoleLogin === false &&
  state.runtimeRoleConnectionLimit === 0 &&
  state.runtimeRoleSessions === 0 &&
  state.normalTrafficRevision === NORMAL_REVISION &&
  state.normalTrafficPercent === 100;

const closeoutPortNames = [
  "inspectApproval",
  "reserveRevocation",
  "revoke",
  "readRevocation",
  "removeEnabledTag",
  "disableRuntimeRole",
  "readClosedState",
];

async function containR10(plan, ports) {
  const failures = [];
  let approvalState;
  try {
    approvalState = await ports.inspectApproval(plan);
  } catch {
    failures.push("INSPECT_APPROVAL");
  }
  if (active(approvalState, plan)) {
    try {
      await ports.reserveRevocation(plan);
      await ports.revoke(plan);
      const readback = await ports.readRevocation(plan);
      if (!revoked(readback, plan)) failures.push("REVOKE_READBACK");
    } catch {
      failures.push("REVOKE");
    }
  } else if (!inactive(approvalState)) {
    failures.push("APPROVAL_UNCONFIRMED");
  }
  try {
    await ports.removeEnabledTag(plan);
  } catch {
    failures.push("REMOVE_TAG");
  }
  try {
    await ports.disableRuntimeRole(plan);
  } catch {
    failures.push("DISABLE_RUNTIME");
  }
  let finalState;
  try {
    finalState = await ports.readClosedState(plan);
  } catch {
    failures.push("CLOSEOUT_READBACK");
  }
  if (!closed(finalState)) failures.push("CLOSEOUT_UNCONFIRMED");
  return Object.freeze({
    status: closed(finalState) ? "CLOSED" : "UNCONFIRMED",
    failures: Object.freeze([...new Set(failures)]),
  });
}

export async function closeR10Runtime(input, ports, now = Date.now()) {
  const plan = requireR10CloseoutWindow(input, now);
  const bound = requirePorts(ports, closeoutPortNames);
  return containR10(plan, bound);
}

export async function executeR10ActivateBeforeDeploy(
  input,
  ports,
  now = Date.now(),
  reserveMs = 4 * 60_000,
) {
  const plan = requireR10ExecutionWindow(input, now, reserveMs);
  const bound = requirePorts(ports, [
    "preflight",
    "reserveActivation",
    "activate",
    "readActivation",
    "reserveDeployment",
    "deployNoTraffic",
    "readDeployment",
    ...closeoutPortNames,
  ]);
  let stage = "PREFLIGHT";
  try {
    const initial = await bound.preflight(plan);
    assert.deepEqual(initial, {
      targetAbsent: true,
      targetTagPresent: false,
      approvalState: "INACTIVE",
      runtimeRoleLogin: true,
      runtimeRoleSessions: 0,
      normalTrafficRevision: NORMAL_REVISION,
      normalTrafficPercent: 100,
    });
    stage = "RESERVE_ACTIVATION";
    await bound.reserveActivation(plan);
    stage = "ACTIVATE";
    await bound.activate(plan);
    stage = "ACTIVATION_READBACK";
    assert.ok(active(await bound.readActivation(plan), plan));
    stage = "RESERVE_DEPLOYMENT";
    await bound.reserveDeployment(plan);
    stage = "DEPLOY_NO_TRAFFIC";
    await bound.deployNoTraffic(plan);
    stage = "DEPLOYMENT_READBACK";
    assert.ok(ready(await bound.readDeployment(plan), plan));
    return Object.freeze({
      status: "READY_FOR_R11",
      revision: plan.revision,
      tag: plan.tag,
      origin: plan.origin,
      normalTrafficRevision: NORMAL_REVISION,
      normalTrafficPercent: 100,
    });
  } catch {
    const closeout = await containR10(plan, bound);
    throw new R10ControllerStop(stage, closeout.status);
  }
}
