import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseTechnicianNotifications,
  technicianNotificationLabels,
} from "./technician-notifications.ts";
const id = "11111111-1111-4111-8111-111111111111";
const row = {
  id,
  jobId: id,
  action: "job.assigned",
  occurredAt: "2026-09-09T12:00:00.000Z",
};
const value = {
  snapshot: true,
  asOf: "2026-09-09T13:00:00.000Z",
  lookbackDays: 90,
  limit: 100,
  hasMore: false,
  items: [row],
};
test("projects privacy-safe fields and fixed labels", () => {
  assert.deepEqual(
    parseTechnicianNotifications({
      ...value,
      secret: "private",
      items: [{ ...row, metadata: { secret: "private" }, body: "private" }],
    }),
    value,
  );
  assert.equal(Object.keys(technicianNotificationLabels).length, 10);
});
for (const [name, change] of Object.entries({
  "not snapshot": { snapshot: false },
  "wrong cap": { limit: 200 },
  "wrong lookback": { lookbackDays: 365 },
  "bad date": { asOf: "today" },
  "false truncation": { hasMore: true },
  duplicate: { items: [row, row] },
  "unknown action": { items: [{ ...row, action: "payment.paid" }] },
  "prototype action": { items: [{ ...row, action: "toString" }] },
  "bad id": { items: [{ ...row, jobId: "private" }] },
  "future event": {
    items: [{ ...row, occurredAt: "2039-01-01T00:00:00.000Z" }],
  },
  "old event": { items: [{ ...row, occurredAt: "2020-01-01T00:00:00.000Z" }] },
  "null row": { items: [null] },
}))
  test(`rejects ${name}`, () =>
    assert.throws(() => parseTechnicianNotifications({ ...value, ...change })));
test("empty is valid", () =>
  assert.equal(
    parseTechnicianNotifications({ ...value, items: [] }).items.length,
    0,
  ));
