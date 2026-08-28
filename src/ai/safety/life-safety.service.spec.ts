import { LifeSafetyService } from "./life-safety.service";

describe("LifeSafetyService", () => {
  const service = new LifeSafetyService();

  it.each([
    "I smell gas near the furnace",
    "There is a natural gas odor in the basement",
    "The gas smell is getting stronger",
    "The carbon monoxide alarm is going off",
    "My CO detector is sounding",
    "There are sparks coming from the unit",
    "Smoke is coming from the electrical panel",
  ])("intercepts life-safety language: %s", (message) => {
    expect(service.assess(message)).toMatchObject({
      status: "safety_escalation",
      requiresHumanHandoff: true,
      emergencyServicesRecommended: true,
    });
  });

  it("does not classify an ordinary no-cooling request as life safety", () => {
    expect(service.assess("My air conditioner is not cooling")).toBeNull();
  });
});
