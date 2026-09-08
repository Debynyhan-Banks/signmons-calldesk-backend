import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SmsEnqueueIntentItem } from "./api";
import {
  filterIntents,
  canReviewIntentRetry,
  retryOutcomeMessage,
  intentFailureLabel,
  intentStatusLabel,
} from "./notification-intents.ts";

describe("notification enqueue intents", () => {
  const retryable = {
    id: "intent",
    status: "FAILED",
    attemptCount: 5,
    communicationEventId: null,
    templateKey: "APPOINTMENT_CONFIRMED",
    updatedAt: "2026-09-08T12:00:00.000Z",
  } as SmsEnqueueIntentItem;
  it("offers review only for verified access and a canonical exhausted snapshot", () => {
    assert.equal(canReviewIntentRetry(retryable, true), true);
    assert.equal(
      canReviewIntentRetry(
        { ...retryable, templateKey: "APPOINTMENT_CANCELLED" },
        true,
      ),
      true,
    );
    assert.equal(
      canReviewIntentRetry(
        { ...retryable, templateKey: "TECHNICIAN_ON_THE_WAY" },
        true,
      ),
      true,
    );
    assert.equal(canReviewIntentRetry(retryable, false), false);
    assert.equal(
      canReviewIntentRetry(retryable, "true" as unknown as boolean),
      false,
    );
    for (const patch of [
      { status: "PENDING" },
      { status: "STALE" },
      { status: "QUEUED" },
      { attemptCount: 4 },
      { attemptCount: 6 },
      { communicationEventId: "event" },
      { templateKey: "APPOINTMENT_RESCHEDULED" },
      { updatedAt: undefined },
      { updatedAt: "invalid" },
      { updatedAt: "2026-02-30T12:00:00.000Z" },
      { updatedAt: "2026-09-08T12:00:00Z" },
    ])
      assert.equal(
        canReviewIntentRetry(
          { ...retryable, ...patch } as SmsEnqueueIntentItem,
          true,
        ),
        false,
      );
  });
  it("requires refresh after rejected requests and treats transport/server errors as uncertain", () => {
    for (const status of [400, 401, 403, 404, 409, 429])
      assert.match(retryOutcomeMessage(status), /load history/i);
    for (const status of [undefined, 500, 502])
      assert.match(
        retryOutcomeMessage(status),
        /outcome uncertain.*may have accepted/,
      );
    assert.match(retryOutcomeMessage(409), /changed/);
    assert.match(retryOutcomeMessage(429), /Wait a minute/);
  });
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
