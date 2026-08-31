import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IntakeReviewSummary } from "./api";
import { filterIntakes, intakeMetrics } from "./intake-review.ts";

const intake = (
  overrides: Partial<IntakeReviewSummary> = {},
): IntakeReviewSummary => ({
  jobId: "job-1",
  reference: "ABCD1234",
  customerName: "Test Banks",
  phone: "2165550111",
  serviceAddress: "123 Test Street",
  serviceCategory: "HEATING",
  issueSummary: "No heat",
  urgency: "STANDARD",
  priority: "STANDARD",
  preferredWindow: "Tomorrow morning",
  photos: [],
  paymentStatus: "NOT_REQUESTED",
  depositRequired: false,
  status: "CREATED",
  sourceChannel: "website_chat",
  createdAt: "2026-08-31T15:00:00.000Z",
  readiness: {
    state: "READY_TO_ASSIGN",
    missingFields: [],
    assessedAt: "2026-08-31T15:01:00.000Z",
  },
  ...overrides,
});

describe("intake review helpers", () => {
  it("computes queue metrics without treating standard work as priority", () => {
    const data = [
      intake(),
      intake({
        jobId: "job-2",
        priority: "EMERGENCY",
        readiness: {
          state: "MISSING_INFO",
          missingFields: ["serviceAddress"],
          assessedAt: "2026-08-31T15:01:00.000Z",
        },
      }),
    ];

    assert.deepEqual(intakeMetrics(data), {
      total: 2,
      missing: 1,
      ready: 1,
      priority: 1,
    });
  });

  it("filters by readiness, priority, and case-insensitive search", () => {
    const missing = intake({
      jobId: "job-2",
      customerName: "Jordan Lee",
      priority: "HIGH",
      readiness: {
        state: "MISSING_INFO",
        missingFields: ["phone"],
        assessedAt: "2026-08-31T15:01:00.000Z",
      },
    });
    const data = [intake(), missing];

    assert.deepEqual(filterIntakes(data, "missing", "jordan"), [missing]);
    assert.deepEqual(filterIntakes(data, "priority", ""), [missing]);
    assert.deepEqual(filterIntakes(data, "ready", "ABCD"), [data[0]]);
  });
});
