import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import {
  controlledIntakeConflict,
  controlledIntakeRefusalStage,
  markControlledIntakeRefusal,
  recordControlledIntakeRefusal,
} from "./controlled-intake-refusal";

describe("controlled intake refusal diagnostics", () => {
  it("keeps the stage outside the enumerable error and preserves the first trusted stage", () => {
    const error = controlledIntakeConflict(
      "INTAKE_STATE_CHANGED",
      "PRIVATE_REASON",
    );
    markControlledIntakeRefusal(error, "CURRENT_VERIFICATION_UNAVAILABLE");
    expect(controlledIntakeRefusalStage(error)).toBe("INTAKE_STATE_CHANGED");
    expect(JSON.stringify(error)).not.toContain("INTAKE_STATE_CHANGED");
    expect(
      controlledIntakeRefusalStage(
        markControlledIntakeRefusal(
          new ServiceUnavailableException("private"),
          "CURRENT_VERIFICATION_UNAVAILABLE",
        ),
      ),
    ).toBeUndefined();
    expect(
      controlledIntakeRefusalStage(new ConflictException("untagged")),
    ).toBeUndefined();
  });

  it("logs exactly one fixed submit refusal and suppresses every other diagnostic", () => {
    const warn = jest.fn();
    const logging = { warn };
    recordControlledIntakeRefusal(logging, {
      operation: "submit",
      status: 409,
      refusalStage: "CURRENT_VERIFICATION_UNAVAILABLE",
    });
    expect(warn).toHaveBeenCalledWith(
      "CONTROLLED_INTAKE_REFUSAL operation=submit status=409 stage=CURRENT_VERIFICATION_UNAVAILABLE",
      "ControlledIntakeRuntime",
    );
    for (const entry of [
      { operation: "draft", status: 409 as const },
      { operation: "submit", status: 503 as const },
      { operation: "submit", status: 409 as const },
    ])
      recordControlledIntakeRefusal(logging, entry);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /phone|address|token|requestId|PRIVATE/,
    );
  });
});
