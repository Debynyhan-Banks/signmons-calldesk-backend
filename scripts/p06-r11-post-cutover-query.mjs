import assert from "node:assert/strict";

export const fixedScope = Object.freeze({
  tenantId: "a1adcfd4-15be-404b-9ac3-5edb1fda20f0",
  accountId: "c8c98ce0-ea9c-4ab3-b8a3-1c2957061fd3",
});

export const sql = Object.freeze({
  phone: `SELECT action,jsonb_typeof(metadata->'version') AS "versionType",metadata->>'version' AS "versionText",jsonb_typeof(metadata->'state') AS "stateType",metadata->>'state' AS "stateText",jsonb_typeof(metadata->'currency') AS "currencyType",metadata->>'currency' AS "currencyText",jsonb_typeof(metadata->'reservedMicros') AS "reservedType",metadata->>'reservedMicros' AS "reservedText" FROM "AuditLog" WHERE action IN ('conversation.staging_phone_held','conversation.controlled_phone_held') AND metadata->>'accountSid'=$1 ORDER BY "createdAt",id LIMIT 10001`,
  addressTotals: `SELECT count(*)::text AS "accountCount",coalesce(sum("heldMicros"),0)::text AS "accountHeldMicros",count(*) FILTER(WHERE "tenantId"=$2::uuid)::text AS "tenantCount",coalesce(sum("heldMicros") FILTER(WHERE "tenantId"=$2::uuid),0)::text AS "tenantHeldMicros" FROM "AddressVerificationOperation" WHERE "accountId"=$1::uuid`,
  addressInvalid: `SELECT count(*) FILTER(WHERE "heldMicros"<0 OR state::text NOT IN ('RESERVED','DISPATCH_CLAIMED','OBSERVED','UNCERTAIN','CANCELLED'))::text AS "invalidCount" FROM "AddressVerificationOperation" WHERE "accountId"=$1::uuid`,
  approvals: `SELECT settings#>'{controlledPhoneApproval,enabled}' AS "phoneEnabled",settings#>'{controlledRuntimeApproval,enabled}' AS "runtimeEnabled" FROM "TenantOrganization" WHERE id=$1::uuid LIMIT 2`,
  role: `SELECT rolcanlogin AS "canLogin",rolconnlimit AS "connectionLimit",COALESCE(rolvaliduntil < now(),true) AS expired FROM pg_roles WHERE rolname='p06_intake_runtime' LIMIT 2`,
  sessions: `SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename='p06_intake_runtime'`,
});

const integer = (value) => {
  assert.equal(typeof value, "string");
  assert.match(value, /^(0|[1-9][0-9]{0,15})$/);
  const parsed = Number(value);
  assert.ok(Number.isSafeInteger(parsed));
  return parsed;
};

const signedInteger = (value) => {
  assert.equal(typeof value, "string");
  assert.match(value, /^-?(0|[1-9][0-9]{0,15})$/);
  const parsed = Number(value);
  assert.ok(Number.isSafeInteger(parsed));
  return parsed;
};

export function parsePhone(rows) {
  assert.ok(Array.isArray(rows) && rows.length <= 10000);
  let validHoldCount = 0;
  let heldMicros = 0;
  let invalidRowCount = 0;
  for (const row of rows) {
    const amount =
      typeof row.reservedText === "string" &&
      /^(0|[1-9][0-9]{0,15})$/.test(row.reservedText)
        ? Number(row.reservedText)
        : NaN;
    const valid =
      (row.action === "conversation.staging_phone_held" ||
        row.action === "conversation.controlled_phone_held") &&
      row.versionType === "number" &&
      row.versionText === "1" &&
      row.stateType === "string" &&
      row.stateText === "HELD" &&
      row.currencyType === "string" &&
      row.currencyText === "USD" &&
      row.reservedType === "number" &&
      Number.isSafeInteger(amount) &&
      amount === 500000;
    if (!valid) {
      invalidRowCount += 1;
      continue;
    }
    validHoldCount += 1;
    heldMicros += amount;
  }
  return {
    totalRowCount: rows.length,
    validHoldCount,
    heldMicros,
    invalidRowCount,
  };
}

export function classify({ phone, address, runtime }) {
  const runtimeShapeValid =
    typeof runtime.phoneApprovalEnabled === "boolean" &&
    typeof runtime.runtimeApprovalEnabled === "boolean" &&
    typeof runtime.canLogin === "boolean" &&
    Number.isInteger(runtime.connectionLimit) &&
    typeof runtime.expired === "boolean" &&
    Number.isInteger(runtime.sessionCount) &&
    runtime.sessionCount >= 0;
  if (!runtimeShapeValid)
    return { status: "QUALIFICATION_DRIFT_STOP", reason: "RUNTIME_SHAPE" };
  const runtimeClosed =
    !runtime.phoneApprovalEnabled &&
    !runtime.runtimeApprovalEnabled &&
    !runtime.canLogin &&
    runtime.connectionLimit === 0 &&
    runtime.expired &&
    runtime.sessionCount === 0;
  if (!runtimeClosed)
    return { status: "QUALIFICATION_DRIFT_STOP", reason: "RUNTIME_OPEN" };
  if (phone.invalidRowCount || address.invalidCount)
    return {
      status: "QUALIFICATION_DRIFT_STOP",
      reason: "INVALID_LIABILITY_ROW",
    };
  const liabilityDecisionRequired =
    phone.validHoldCount >= 15 ||
    phone.heldMicros >= 7500000 ||
    address.accountCount >= 11 ||
    address.accountHeldMicros >= 1100000 ||
    address.tenantCount >= 11 ||
    address.tenantHeldMicros >= 1100000;
  return {
    status: liabilityDecisionRequired
      ? "LIABILITY_DECISION_REQUIRED"
      : "PHASE_A_CLOSED",
    reason: liabilityDecisionRequired
      ? "HISTORICAL_CEILING_REACHED"
      : "CLOSED_SNAPSHOT",
    runtimeClosed,
    liabilityDecisionRequired,
  };
}

export async function readPhaseA(client, accountSid, mark = () => {}) {
  mark("READ_ONLY_MODE");
  assert.equal(
    (await client.query("SHOW transaction_read_only")).rows[0]
      ?.transaction_read_only,
    "on",
  );
  mark("PHONE_AGGREGATE");
  const phone = parsePhone((await client.query(sql.phone, [accountSid])).rows);
  mark("ADDRESS_TOTALS_QUERY");
  const totalsRows = (
    await client.query(sql.addressTotals, [
      fixedScope.accountId,
      fixedScope.tenantId,
    ])
  ).rows;
  mark("ADDRESS_TOTALS_PARSE");
  assert.equal(totalsRows.length, 1);
  assert.deepEqual(Object.keys(totalsRows[0]).sort(), [
    "accountCount",
    "accountHeldMicros",
    "tenantCount",
    "tenantHeldMicros",
  ]);
  const address = {
    accountCount: integer(totalsRows[0].accountCount),
    accountHeldMicros: signedInteger(totalsRows[0].accountHeldMicros),
    tenantCount: integer(totalsRows[0].tenantCount),
    tenantHeldMicros: signedInteger(totalsRows[0].tenantHeldMicros),
  };
  mark("ADDRESS_INVALID_QUERY");
  const invalidRows = (
    await client.query(sql.addressInvalid, [fixedScope.accountId])
  ).rows;
  mark("ADDRESS_INVALID_PARSE");
  assert.equal(invalidRows.length, 1);
  assert.deepEqual(Object.keys(invalidRows[0]), ["invalidCount"]);
  address.invalidCount = integer(invalidRows[0].invalidCount);
  if (address.invalidCount === 0)
    assert.ok(
      address.tenantCount <= address.accountCount &&
        address.tenantHeldMicros <= address.accountHeldMicros &&
        address.accountHeldMicros >= 0 &&
        address.tenantHeldMicros >= 0,
    );
  mark("APPROVAL_STATE");
  const approvals = (await client.query(sql.approvals, [fixedScope.tenantId]))
    .rows;
  assert.equal(approvals.length, 1);
  mark("RUNTIME_ROLE");
  const roles = (await client.query(sql.role)).rows;
  assert.equal(roles.length, 1);
  mark("RUNTIME_SESSIONS");
  const sessions = (await client.query(sql.sessions)).rows;
  assert.equal(sessions.length, 1);
  const runtime = {
    phoneApprovalEnabled: approvals[0].phoneEnabled,
    runtimeApprovalEnabled: approvals[0].runtimeEnabled,
    canLogin: roles[0].canLogin,
    connectionLimit: roles[0].connectionLimit,
    expired: roles[0].expired,
    sessionCount: sessions[0].count,
  };
  return {
    ...classify({ phone, address, runtime }),
    phone,
    address,
    runtime,
    executionAuthorized: false,
  };
}
