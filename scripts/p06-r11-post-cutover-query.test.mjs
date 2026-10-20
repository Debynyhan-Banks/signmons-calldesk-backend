import test from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  parsePhone,
  readPhaseA,
  sql,
} from "./p06-r11-post-cutover-query.mjs";

const row = (overrides = {}) => ({
  action: "conversation.controlled_phone_held",
  versionType: "number",
  versionText: "1",
  stateType: "string",
  stateText: "HELD",
  currencyType: "string",
  currencyText: "USD",
  reservedType: "number",
  reservedText: "500000",
  ...overrides,
});
const base = () => ({
  phone: {
    totalRowCount: 14,
    validHoldCount: 14,
    heldMicros: 7000000,
    invalidRowCount: 0,
  },
  address: {
    accountCount: 9,
    accountHeldMicros: 900000,
    tenantCount: 9,
    tenantHeldMicros: 900000,
    invalidCount: 0,
  },
  runtime: {
    phoneApprovalEnabled: false,
    runtimeApprovalEnabled: false,
    canLogin: false,
    connectionLimit: 0,
    expired: true,
    sessionCount: 0,
  },
});

test("valid and invalid phone rows are counted without exposing rows", () => {
  assert.deepEqual(parsePhone([row(), row({ reservedText: "600000" })]), {
    totalRowCount: 2,
    validHoldCount: 1,
    heldMicros: 500000,
    invalidRowCount: 1,
  });
});
test("closed snapshot is reviewable", () =>
  assert.equal(classify(base()).status, "PHASE_A_CLOSED"));
test("historical ceiling requires a later liability decision", () => {
  const value = base();
  value.phone.validHoldCount = 15;
  value.phone.heldMicros = 7500000;
  assert.equal(classify(value).status, "LIABILITY_DECISION_REQUIRED");
});
for (const [name, key, value] of [
  ["phone approval", "phoneApprovalEnabled", true],
  ["runtime approval", "runtimeApprovalEnabled", true],
  ["login", "canLogin", true],
  ["connection limit", "connectionLimit", 1],
  ["expiry", "expired", false],
  ["session", "sessionCount", 1],
])
  test(name + " stops", () => {
    const input = base();
    input.runtime[key] = value;
    assert.equal(classify(input).reason, "RUNTIME_OPEN");
  });
test("invalid liability row stops", () => {
  const input = base();
  input.phone.invalidRowCount = 1;
  assert.equal(classify(input).reason, "INVALID_LIABILITY_ROW");
});
test("runtime shape drift stops", () => {
  const input = base();
  input.runtime.sessionCount = "0";
  assert.equal(classify(input).reason, "RUNTIME_SHAPE");
});

function clientFor(address, overrides = {}) {
  const responses = new Map([
    ["SHOW transaction_read_only", [{ transaction_read_only: "on" }]],
    [sql.phone, [row()]],
    [
      sql.addressTotals,
      [
        {
          accountCount: address.accountCount,
          accountHeldMicros: address.accountHeldMicros,
          tenantCount: address.tenantCount,
          tenantHeldMicros: address.tenantHeldMicros,
        },
      ],
    ],
    [sql.addressInvalid, [{ invalidCount: address.invalidCount }]],
    [sql.approvals, [{ phoneEnabled: false, runtimeEnabled: false }]],
    [sql.role, [{ canLogin: false, connectionLimit: 0, expired: true }]],
    [sql.sessions, [{ count: 0 }]],
  ]);
  return {
    query: async (text) => ({ rows: overrides[text] ?? responses.get(text) }),
  };
}

test("full reader marks every successful substage", async () => {
  const marks = [];
  const address = {
    accountCount: "1",
    accountHeldMicros: "100000",
    tenantCount: "1",
    tenantHeldMicros: "100000",
    invalidCount: "0",
  };
  const result = await readPhaseA(
    clientFor(address),
    "AC" + "a".repeat(32),
    (stage) => marks.push(stage),
  );
  assert.equal(result.status, "PHASE_A_CLOSED");
  assert.deepEqual(marks, [
    "READ_ONLY_MODE",
    "PHONE_AGGREGATE",
    "ADDRESS_TOTALS_QUERY",
    "ADDRESS_TOTALS_PARSE",
    "ADDRESS_INVALID_QUERY",
    "ADDRESS_INVALID_PARSE",
    "APPROVAL_STATE",
    "RUNTIME_ROLE",
    "RUNTIME_SESSIONS",
  ]);
});

test("negative address data is classified invalid without parser loss", async () => {
  const address = {
    accountCount: "1",
    accountHeldMicros: "-1",
    tenantCount: "1",
    tenantHeldMicros: "-1",
    invalidCount: "1",
  };
  const result = await readPhaseA(clientFor(address), "AC" + "a".repeat(32));
  assert.equal(result.reason, "INVALID_LIABILITY_ROW");
});

test("address totals parse failures retain their exact stage", async () => {
  const address = {
    accountCount: "bad",
    accountHeldMicros: "100000",
    tenantCount: "1",
    tenantHeldMicros: "100000",
    invalidCount: "0",
  };
  let last = "";
  await assert.rejects(() =>
    readPhaseA(clientFor(address), "AC" + "a".repeat(32), (stage) => {
      last = stage;
    }),
  );
  assert.equal(last, "ADDRESS_TOTALS_PARSE");
});
