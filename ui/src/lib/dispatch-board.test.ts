import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DispatchBoardSummary, DispatchQueue } from "./api";
import {
  dispatchMetrics,
  dispatchQueueLabel,
  filterDispatchBoard,
  formatDispatchDate,
  formatDispatchWindow,
} from "./dispatch-board.ts";

const item = (
  queue: DispatchQueue,
  reference: string,
): DispatchBoardSummary => ({
  jobId: reference,
  reference,
  queue,
  serviceCategory: "HEATING",
  urgency: "STANDARD",
  status: "ACCEPTED",
  technicianStatus: queue === "ASSIGNED" ? "ASSIGNED" : null,
  serviceWindowStart: "2026-09-01T13:00:00.000Z",
  serviceWindowEnd: "2026-09-01T15:00:00.000Z",
  timezone: "America/New_York",
  assignedTechnician:
    queue === "ASSIGNED"
      ? { id: "tech-1", fullName: "Jordan Tech", role: "TECH" }
      : null,
  createdAt: "2026-08-31T15:00:00.000Z",
  updatedAt: "2026-08-31T15:00:00.000Z",
});

describe("dispatch board helpers", () => {
  const items = [
    item("NEW_REQUEST", "NEW00001"),
    item("READY_TO_ASSIGN", "READY001"),
    item("ASSIGNED", "ASSIGN01"),
    item("ESCALATED", "ESCAL001"),
  ];

  it("counts operational queues", () => {
    assert.deepEqual(dispatchMetrics(items), {
      total: 4,
      newRequests: 1,
      ready: 1,
      assigned: 1,
      escalated: 1,
    });
  });

  it("filters by queue and privacy-safe operational fields", () => {
    assert.equal(filterDispatchBoard(items, "ESCALATED", "").length, 1);
    assert.equal(filterDispatchBoard(items, "all", "jordan").length, 1);
    assert.equal(
      filterDispatchBoard(items, "all", "ready")[0].reference,
      "READY001",
    );
  });

  it("uses clear queue labels", () => {
    assert.equal(dispatchQueueLabel("READY_TO_ASSIGN"), "Ready to assign");
  });

  it("formats all dispatch timestamps in the tenant timezone", () => {
    assert.equal(
      formatDispatchWindow(
        "2026-09-02T19:00:00.000Z",
        "2026-09-02T22:00:00.000Z",
        "America/New_York",
      ),
      "Wed, Sep 2 · 3:00 PM–6:00 PM",
    );
    assert.equal(
      formatDispatchDate(
        "2026-09-01T10:25:00.000Z",
        "America/New_York",
      ),
      "Sep 1, 6:25 AM",
    );
  });
});
