import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readAddressCapacity, scope } from "./p06-r11-address-capacity-diagnostic.mjs";

const row = (a = "0", h = "0", t = a, th = h) => ({
  accountCount: a, accountHeldMicros: h, tenantCount: t,
  tenantHeldMicros: th, invalidCount: "0",
});
function fixture(rows, readonly = "on") {
  const calls = [];
  return { calls, async query(sql, values) {
    calls.push({ sql, values });
    if (calls.length === 1) return { rows: [{ transaction_read_only: readonly }] };
    assert.equal(calls.length, 2, "no query retry");
    return { rows };
  } };
}

test("fixed account aggregate matches ledger count and sum including every state", async () => {
  const c = fixture([row("1", "100000")]);
  const result = await readAddressCapacity(c);
  assert.equal(result.status, "CAPACITY_AVAILABLE_OTHER_GATE");
  assert.deepEqual(c.calls[1].values, [scope.accountId, scope.tenantId]);
  assert.match(c.calls[1].sql, /FROM "AddressVerificationOperation" WHERE "accountId"=\$1::uuid$/);
  assert.doesNotMatch(c.calls[1].sql, /SELECT\s+\*|\b(INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i);
  assert.equal(Object.keys(result).length, 11);
});
test("zero rows aggregate leaves capacity", async () => {
  assert.equal((await readAddressCapacity(fixture([row()]))).status, "CAPACITY_AVAILABLE_OTHER_GATE");
});
test("exact two-operation count blocks even when retained cost is zero", async () => {
  assert.equal((await readAddressCapacity(fixture([row("2", "0")]))).status, "ACCOUNT_AND_TENANT_LIMIT_EXCEEDED");
});
test("cost addition exceeding ceiling blocks; prior other tenants count at account scope", async () => {
  const v = await readAddressCapacity(fixture([row("1", "100001", "0", "0")]));
  assert.equal(v.status, "ACCOUNT_LIMIT_EXCEEDED");
  assert.equal(v.tenantCapacity, true);
});
test("over-limit totals stay blocked", async () => {
  assert.equal((await readAddressCapacity(fixture([row("5", "500000")]))).status, "ACCOUNT_AND_TENANT_LIMIT_EXCEEDED");
});
test("unexpected, unsafe and inconsistent results fail closed", async () => {
  for (const rows of [[], [row(), row()], [{...row(), privateValue: "forbidden"}],
    [{...row(), invalidCount: "1"}], [row("-1")], [row("01")],
    [row("9007199254740992")], [row("1", "0", "2", "0")],
    [row("0", "100000")], [row("1", "0", "1", "1")],
    [{...row(), accountCount: 0}], [{...row(), accountHeldMicros: "NaN"}]]) {
    await assert.rejects(readAddressCapacity(fixture(rows)));
  }
});
test("read-write transaction refuses before aggregate", async () => {
  const c = fixture([row()], "off");
  await assert.rejects(readAddressCapacity(c));
  assert.equal(c.calls.length, 1);
});
test("query failure cannot trigger another query", async () => {
  let count = 0;
  await assert.rejects(readAddressCapacity({async query() { count++; throw Error("synthetic"); }}));
  assert.equal(count, 1);
});
test("direct invocation is inert and has no credential or connection dependency", () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./p06-r11-address-capacity-diagnostic.mjs", import.meta.url))]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.length + r.stderr.length, 0);
});
