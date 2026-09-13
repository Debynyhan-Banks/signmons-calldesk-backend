import { controlledIntakeSubmission } from "./controlled-intake-submission";
import { validateCustomerIntakeDraft } from "./customer-intake-draft";

const request = () => ({
  version: 2,
  sessionToken: "private",
  requestId: "11111111-1111-4111-8111-111111111111",
  expectedRevision: 1,
  confirmed: true,
  draft: {
    customerName: "Fictional Customer",
    phone: "+12025550123",
    address: "123 Fictional Street, Example, OH 44101",
    description: "Routine inspection",
    issueCategory: "HEATING",
    propertyType: "RESIDENTIAL",
    serviceIntent: "MAINTENANCE",
  },
  confirmedAddress: {
    street: "123 Fictional Street",
    unit: "",
    city: "Example",
    postalCode: "44101",
  },
});
describe("controlled version2 submission", () => {
  it("copies and binds the confirmed address without changing the legacy draft", () => {
    const input = request();
    const result = controlledIntakeSubmission(input);
    input.confirmedAddress.street = "changed";
    input.draft.description = "changed";
    expect(result.confirmedAddress.street).toBe("123 Fictional Street");
    expect(result.draft.description).toBe("Routine inspection");
    expect(Object.isFrozen(result.confirmedAddress)).toBe(true);
    expect(validateCustomerIntakeDraft(request().draft)).toEqual(
      request().draft,
    );
  });
  it("accepts an explicitly matching unit and ZIP+4", () => {
    const input = request();
    input.confirmedAddress.unit = "Unit 2";
    input.confirmedAddress.postalCode = "44101-1234";
    input.draft.address =
      "123 Fictional Street, Unit 2, Example, OH 44101-1234";
    expect(controlledIntakeSubmission(input).confirmedAddress.unit).toBe(
      "Unit 2",
    );
  });
  it.each([
    { version: 1 },
    { confirmed: false },
    { expectedRevision: 0 },
    { requestId: "bad" },
    { sessionToken: "" },
    { proof: true },
    { tenantId: "foreign" },
    { urgency: "EMERGENCY" },
  ])("refuses malformed or authority input %j", (patch) => {
    expect(() =>
      controlledIntakeSubmission({ ...request(), ...patch }),
    ).toThrow();
  });
  it.each([
    { street: "other" },
    { unit: "Unit 2" },
    { city: "Other" },
    { postalCode: "44102" },
    { country: "US" },
    { postalCode: "bad" },
  ])("refuses expanded or contradictory parts %j", (patch) => {
    const input = request();
    expect(() =>
      controlledIntakeSubmission({
        ...input,
        confirmedAddress: { ...input.confirmedAddress, ...patch },
      }),
    ).toThrow();
  });
  it("does not parse a free-text address or accept a foreign phone", () => {
    const input = request();
    input.draft.address = "unstructured customer text";
    expect(() => controlledIntakeSubmission(input)).toThrow();
    const foreign = request();
    foreign.draft.phone = "+442079460123";
    expect(() => controlledIntakeSubmission(foreign)).toThrow();
  });
});
