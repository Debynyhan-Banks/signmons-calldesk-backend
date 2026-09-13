import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SmsHistoryItem } from "./api";
import {
  filterHistory,
  historyTime,
  messageLabel,
  statusLabel,
  validHistoryJobId,
} from "./notification-history.ts";

describe("notification history", () => {
  const items = [
    "QUEUED",
    "SENDING",
    "SENT",
    "DELIVERED",
    "FAILED",
    "DEAD_LETTER",
    "RECEIVED",
  ].map((status) => ({ status }) as SmsHistoryItem);
  it("separates unconfirmed delivery from delivered and inbound records", () => {
    assert.equal(filterHistory(items, "all").length, 7);
    assert.deepEqual(
      filterHistory(items, "pending").map((item) => item.status),
      ["QUEUED", "SENDING", "SENT"],
    );
    assert.deepEqual(
      filterHistory(items, "delivered").map((item) => item.status),
      ["DELIVERED"],
    );
  });
  it("surfaces both failed and stopped messages for attention", () => {
    assert.deepEqual(
      filterHistory(items, "attention").map((item) => item.status),
      ["FAILED", "DEAD_LETTER"],
    );
  });
  it("does not label provider acceptance as delivered or offer automatic replay", () => {
    assert.equal(statusLabel("SENT"), "Sent · delivery unconfirmed");
    assert.equal(statusLabel("DEAD_LETTER"), "Stopped · review required");
    assert.equal(statusLabel("FAILED"), "Failed · retry may be pending");
  });
  it("uses a bounded label for unknown or absent templates", () => {
    assert.equal(
      messageLabel("TECHNICIAN_ON_THE_WAY"),
      "Technician on the way",
    );
    assert.equal(messageLabel(null), "SMS activity");
    assert.equal(messageLabel("__proto__"), "SMS activity");
    assert.equal(messageLabel("sensitive unknown value"), "SMS activity");
  });
  it("accepts an empty filter or valid UUID only", () => {
    assert.equal(validHistoryJobId(""), true);
    assert.equal(
      validHistoryJobId("10000000-0000-4000-8000-000000000001"),
      true,
    );
    assert.equal(validHistoryJobId("not-a-job"), false);
    assert.equal(
      validHistoryJobId("10000000-0000-4000-8000-000000000001&limit=1000"),
      false,
    );
  });
  it("labels timezone explicitly and handles unavailable timestamps", () => {
    assert.equal(
      historyTime("2026-09-08T14:00:00.000Z"),
      "2026-09-08 14:00:00 UTC",
    );
    assert.equal(historyTime("invalid"), "Time unavailable");
  });
});
