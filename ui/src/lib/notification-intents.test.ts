import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SmsEnqueueIntentItem } from "./api";
import {
  filterIntents,
  intentFailureLabel,
  intentStatusLabel,
} from "./notification-intents.ts";

describe("notification enqueue intents", () => {
  const items = ["PENDING", "QUEUED", "STALE", "FAILED"].map(
    (status, index) =>
      ({
        id: String(index),
        status,
        jobId: index === 3 ? "OTHER" : "JOB",
      }) as SmsEnqueueIntentItem,
  );
  it("keeps queue acknowledgment separate from pending and stopped work", () => {
    assert.equal(filterIntents(items, "all").length, 4);
    assert.deepEqual(
      filterIntents(items, "pending").map((item) => item.status),
      ["PENDING"],
    );
    assert.deepEqual(
      filterIntents(items, "queued").map((item) => item.status),
      ["QUEUED"],
    );
    assert.deepEqual(
      filterIntents(items, "attention").map((item) => item.status),
      ["STALE", "FAILED"],
    );
  });
  it("intersects status with a case-insensitive job filter within loaded records only", () => {
    assert.equal(filterIntents(items, "all", "job").length, 3);
    assert.equal(filterIntents(items, "attention", "JOB").length, 1);
    assert.equal(filterIntents(items, "all", "missing").length, 0);
  });
  it("does not promise delivery or retries for stopped intents", () => {
    assert.equal(
      intentStatusLabel("QUEUED"),
      "Queue acknowledged · not delivery",
    );
    assert.equal(intentStatusLabel("PENDING"), "Pending enqueue");
    assert.equal(intentStatusLabel("FAILED"), "Stopped · retries exhausted");
    assert.equal(intentStatusLabel("STALE"), "Stopped · state changed");
  });
  it("uses bounded labels for unknown status and error values", () => {
    assert.equal(
      intentStatusLabel("__proto__" as SmsEnqueueIntentItem["status"]),
      "Unknown intent status",
    );
    assert.equal(
      intentFailureLabel("private raw error"),
      "Unrecognized failure code",
    );
    assert.equal(intentFailureLabel(null), "None recorded");
    assert.equal(intentFailureLabel("enqueue_failed"), "Enqueue failed");
    assert.equal(
      intentFailureLabel("stale_lifecycle_state"),
      "Lifecycle state changed",
    );
  });
});
