import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UrgencyReviewSummary } from "./api";
import {
  filterUrgencyReviews,
  urgencyLabel,
  urgencyMetrics,
} from "./urgency-review.ts";

const item = (
  urgency: UrgencyReviewSummary["urgency"],
  reference: string,
): UrgencyReviewSummary => ({
  jobId: reference,
  reference,
  urgency,
  serviceCategory: "HEATING",
  status: "CREATED",
  createdAt: "2026-08-31T15:00:00.000Z",
  rationale: {
    decisionSource: "AI_INTAKE",
    reasonCodes: ["NO_ESCALATION_SIGNAL"],
    triggerDetails: ["No escalation signal was recorded."],
    confidenceNote: "Operator verification required.",
  },
  escalationPath: [],
});

describe("urgency review helpers", () => {
  const items = [
    item("EMERGENCY", "EMER0001"),
    item("HIGH", "HIGH0001"),
    item("STANDARD", "STAN0001"),
  ];

  it("counts all three persisted urgency levels", () => {
    assert.deepEqual(urgencyMetrics(items), {
      total: 3,
      emergency: 1,
      high: 1,
      standard: 1,
    });
  });

  it("filters by urgency and privacy-safe search fields", () => {
    assert.equal(filterUrgencyReviews(items, "high", "").length, 1);
    assert.equal(
      filterUrgencyReviews(items, "all", "stan")[0].urgency,
      "STANDARD",
    );
  });

  it("uses an operator-friendly high priority label", () => {
    assert.equal(urgencyLabel("HIGH"), "High priority");
  });
});
