import assert from "node:assert/strict";

// Inert, fixed-scope read helper. Connection, identity, authorization, one-use
// reservation, window, transaction rollback and close belong to the private caller.
export const scope = Object.freeze({
  accountId: "c8c98ce0-ea9c-4ab3-b8a3-1c2957061fd3",
  tenantId: "a1adcfd4-15be-404b-9ac3-5edb1fda20f0",
  costMicros: 100000,
  requestLimit: 2,
  ceilingMicros: 200000,
});

const sql = `SELECT
  count(*)::text AS "accountCount",
  coalesce(sum("heldMicros"),0)::text AS "accountHeldMicros",
  count(*) FILTER (WHERE "tenantId"=$2::uuid)::text AS "tenantCount",
  coalesce(sum("heldMicros") FILTER (WHERE "tenantId"=$2::uuid),0)::text AS "tenantHeldMicros",
  count(*) FILTER (WHERE "heldMicros"<0 OR state NOT IN
    ('RESERVED','DISPATCH_CLAIMED','OBSERVED','UNCERTAIN','CANCELLED'))::text AS "invalidCount"
FROM "AddressVerificationOperation" WHERE "accountId"=$1::uuid`;

function number(value) {
  assert.equal(typeof value, "string");
  assert.match(value, /^(0|[1-9][0-9]{0,15})$/);
  const n = Number(value);
  assert.ok(Number.isSafeInteger(n));
  return n;
}

export async function readAddressCapacity(client) {
  const mode = await client.query("SHOW transaction_read_only");
  assert.equal(mode.rows.length, 1);
  assert.equal(mode.rows[0].transaction_read_only, "on");
  const { rows } = await client.query(sql, [scope.accountId, scope.tenantId]);
  assert.equal(rows.length, 1);
  const keys = ["accountCount", "accountHeldMicros", "tenantCount", "tenantHeldMicros", "invalidCount"];
  assert.deepEqual(Object.keys(rows[0]).sort(), [...keys].sort());
  const v = Object.fromEntries(keys.map((k) => [k, number(rows[0][k])]));
  assert.equal(v.invalidCount, 0);
  assert.ok(v.tenantCount <= v.accountCount);
  assert.ok(v.tenantHeldMicros <= v.accountHeldMicros);
  assert.ok(v.accountCount !== 0 || v.accountHeldMicros === 0);
  assert.ok(v.tenantCount !== 0 || v.tenantHeldMicros === 0);
  const accountCapacity = v.accountCount < scope.requestLimit &&
    v.accountHeldMicros <= scope.ceilingMicros - scope.costMicros;
  const tenantCapacity = v.tenantCount < scope.requestLimit &&
    v.tenantHeldMicros <= scope.ceilingMicros - scope.costMicros;
  const status = accountCapacity && tenantCapacity ? "CAPACITY_AVAILABLE_OTHER_GATE"
    : !accountCapacity && !tenantCapacity ? "ACCOUNT_AND_TENANT_LIMIT_EXCEEDED"
    : !accountCapacity ? "ACCOUNT_LIMIT_EXCEEDED" : "TENANT_LIMIT_EXCEEDED";
  return Object.freeze({ status, ...v, accountCapacity, tenantCapacity,
    costMicros: scope.costMicros, requestLimit: scope.requestLimit,
    ceilingMicros: scope.ceilingMicros });
}
