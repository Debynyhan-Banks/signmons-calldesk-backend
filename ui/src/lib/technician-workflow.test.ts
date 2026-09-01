import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TechnicianJobSummary } from "./api";
import {
  primaryTechnicianAction,
  secondaryTechnicianActions,
  technicianActionLabel,
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
      ["decline", "cannot_take"],
    );
  });

  it("uses field-friendly labels", () => {
    assert.equal(technicianStatusLabel("EN_ROUTE"), "On my way");
    assert.equal(technicianActionLabel("in_progress"), "Start work");
  });
});
