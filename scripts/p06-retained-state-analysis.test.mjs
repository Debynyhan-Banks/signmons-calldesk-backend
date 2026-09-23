import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { analyze, retainedStateTypes } from "./p06-retained-state-analysis.mjs";
const require = createRequire(import.meta.url);
const {
  createControlledPhoneProof,
} = require("../dist/communications/controlled-phone-proof.js");
function fixture() {
  const eventMs = 1000000,
    phoneDigest = "b".repeat(64),
    scope = {
      tenantId: "synthetic-tenant",
      sessionId: "synthetic-session",
      revision: phoneDigest,
      expiresAt: 1100000,
    };
  const policy = {
    mode: "CONTROLLED_VERIFY_V1",
    version: "synthetic",
    accountSid: "AC" + "a".repeat(32),
    serviceSid: "VA" + "c".repeat(32),
    noticeVersion: "synthetic",
    businessPolicyVersion: "synthetic-policy",
    lifetimeMs: 1800000,
  };
  const start = {
    id: "start",
    kind: "START",
    phoneDigest,
    controlledPolicy: policy,
    result: { outcome: "PENDING", verificationSid: "VE" + "d".repeat(32) },
  };
  const check = {
    kind: "CHECK",
    startId: "start",
    phoneDigest,
    result: {
      outcome: "APPROVED",
      verificationSid: start.result.verificationSid,
    },
    controlledProof: createControlledPhoneProof(scope, policy, eventMs - 1000),
  };
  return {
    ledger: { version: 1, entries: [start, check] },
    scope,
    phoneDigest,
    policy,
    eventMs,
    lifecycle: { closedAt: null, expiresAt: scope.expiresAt, purgedAt: null },
    postEventInvalidation: false,
    jobCount: 0,
    address: null,
    observations: [],
  };
}
test("preserves no-job/address distinction without promoting retained proof to admission", () => {
  const r = analyze(fixture());
  assert.equal(r.phoneStage, "RETAINED_PHONE_PREDICATES_PASS");
  assert.equal(r.jobCount, 0);
  assert.equal(r.addressStage, "NO_ADDRESS_ROW");
  assert.equal(r.jobCreated, undefined);
});
test("provider approval without application proof is detected", () => {
  const f = fixture();
  delete f.ledger.entries[1].controlledProof;
  assert.equal(analyze(f).phoneStage, "CONTROLLED_PROOF_ABSENT");
});
test("missing approved check is distinct from missing encrypted ledger", () => {
  const f = fixture();
  f.ledger.entries.pop();
  assert.equal(analyze(f).phoneStage, "APPROVED_CHECK_ABSENT");
  f.ledger = null;
  assert.equal(analyze(f).phoneStage, "LEDGER_UNAVAILABLE");
});
test("scope mismatch and exact deadline fail", () => {
  for (const change of [
    (f) => (f.scope.sessionId = "other"),
    (f) => (f.eventMs = f.scope.expiresAt),
  ]) {
    const f = fixture();
    change(f);
    assert.equal(analyze(f).phoneStage, "PHONE_PROOF_SCOPE_OR_TIME_MISMATCH");
  }
});
test("policy mismatch fails", () => {
  const f = fixture();
  f.policy = { ...f.policy, businessPolicyVersion: "changed" };
  assert.equal(analyze(f).phoneStage, "PHONE_POLICY_MISMATCH");
});
test("start/check provider binding mismatch fails", () => {
  const f = fixture();
  f.ledger.entries[0].result.verificationSid = "VE" + "e".repeat(32);
  assert.equal(analyze(f).phoneStage, "PHONE_LEDGER_BINDING_MISMATCH");
});
test("post-event invalidation cannot establish a historical absence", () => {
  const f = fixture();
  f.postEventInvalidation = true;
  f.ledger.entries[1].controlledProof = null;
  assert.equal(analyze(f).phoneStage, "POST_EVENT_CHANGE_INCONCLUSIVE");
});
test("output omits input identities, digests, policies and raw records", () => {
  const f = fixture();
  f.ledger.entries[1].extraPrivate = "secret-value";
  const s = JSON.stringify(analyze(f));
  for (const v of [
    f.scope.tenantId,
    f.scope.sessionId,
    f.phoneDigest,
    f.policy.accountSid,
    f.policy.serviceSid,
    f.policy.businessPolicyVersion,
    "secret-value",
    "verificationSid",
    "controlledProof",
  ])
    assert.ok(!s.includes(v));
});

test("missing approved CHECK does not imply missing START", () => {
  const f = fixture();
  f.ledger.entries.pop();
  const r = analyze(f);
  assert.equal(r.phoneStage, "APPROVED_CHECK_ABSENT");
  assert.equal(r.startRecordPresent, true);
  assert.equal(r.checks.linkedStartPresent, false);
  assert.equal(r.checks.startPresent, undefined);
});
test("timestamp-without-timezone uses UTC through winter and both DST boundaries", () => {
  const original = process.env.TZ;
  try {
    for (const zone of ["UTC", "America/New_York", "Asia/Tokyo"]) {
      process.env.TZ = zone;
      for (const input of [
        "2026-01-15 11:49:17.331",
        "2026-03-08 02:30:00.000",
        "2026-09-23 11:49:17.331",
        "2026-11-01 01:30:00.000",
      ])
        assert.equal(
          retainedStateTypes.getTypeParser(1114)(input).toISOString(),
          input.replace(" ", "T") + "Z",
        );
      assert.equal(
        retainedStateTypes
          .getTypeParser(1184)("2026-09-23 07:49:17.331-04")
          .toISOString(),
        "2026-09-23T11:49:17.331Z",
      );
      assert.equal(retainedStateTypes.getTypeParser(23)("7"), 7);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
test("explicit UTC prevents false post-event classification without hiding later changes", () => {
  const f = fixture();
  f.ledger.entries.pop();
  const event = Date.parse("2026-09-23T11:50:24.943Z");
  f.eventMs = event;
  const before = retainedStateTypes
    .getTypeParser(1114)("2026-09-23 11:49:17.331")
    .getTime();
  const after = retainedStateTypes
    .getTypeParser(1114)("2026-09-23 11:51:00.000")
    .getTime();
  f.postEventInvalidation = before > event;
  assert.equal(analyze(f).phoneStage, "APPROVED_CHECK_ABSENT");
  f.postEventInvalidation = after > event;
  assert.equal(analyze(f).phoneStage, "POST_EVENT_CHANGE_INCONCLUSIVE");
});
test("parser rejects unbounded/special values and leaves global parsers untouched", () => {
  const { types } = require("pg");
  const original = types.getTypeParser(1114);
  for (const value of [
    "infinity",
    "-infinity",
    "private text",
    "2026-09-23 11:00:00+04",
  ])
    assert.throws(() => retainedStateTypes.getTypeParser(1114)(value));
  assert.equal(types.getTypeParser(1114), original);
});

test("pg Client applies the scoped UTC parser without connecting", () => {
  const { Client } = require("pg");
  const client = new Client({ types: retainedStateTypes });
  assert.equal(
    client.getTypeParser(1114)("2026-09-23 11:49:17.331").toISOString(),
    "2026-09-23T11:49:17.331Z",
  );
});
