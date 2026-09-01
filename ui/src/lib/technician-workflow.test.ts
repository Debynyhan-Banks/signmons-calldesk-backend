import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TechnicianJobSummary } from "./api";
import {
  primaryTechnicianAction,
  secondaryTechnicianActions,
  shouldShowCustomerCall,
  technicianActionLabel,
  technicianGroupAfterAction,
  technicianStatusLabel,
  technicianTokenFromHash,
} from "./technician-workflow.ts";

const job = (availableActions: TechnicianJobSummary["availableActions"]) =>
  ({ availableActions }) as TechnicianJobSummary;

describe("technician workflow helpers", () => {
  it("reads and decodes only the URL fragment token", () => {
    assert.equal(technicianTokenFromHash("#abc.def"), "abc.def");
    assert.equal(technicianTokenFromHash("#abc%2Edef"), "abc.def");
    assert.equal(technicianTokenFromHash("#%E0%A4%A"), "");
  });

  it("prioritizes the forward progress action", () => {
    assert.equal(
      primaryTechnicianAction(job(["decline", "accept", "cannot_take"])),
      "accept",
    );
    assert.deepEqual(
      secondaryTechnicianActions(job(["decline", "accept", "cannot_take"])),
      ["cannot_take"],
    );
    assert.deepEqual(secondaryTechnicianActions(job(["accept", "decline"])), [
      "decline",
    ]);
  });

  it("uses field-friendly labels", () => {
    assert.equal(technicianStatusLabel("EN_ROUTE"), "On my way");
    assert.equal(technicianActionLabel("in_progress"), "Start work");
  });

  it("moves completed work to the completed group", () => {
    assert.equal(
      technicianGroupAfterAction("upcoming", "complete"),
      "completed",
    );
    assert.equal(
      technicianGroupAfterAction("upcoming", "in_progress"),
      "upcoming",
    );
  });

  it("removes the call shortcut after completion", () => {
    assert.equal(
      shouldShowCustomerCall({
        ...job([]),
        technicianStatus: "COMPLETED",
      } as TechnicianJobSummary),
      false,
    );
    assert.equal(
      shouldShowCustomerCall({
        ...job([]),
        technicianStatus: "IN_PROGRESS",
      } as TechnicianJobSummary),
      true,
    );
  });
});
