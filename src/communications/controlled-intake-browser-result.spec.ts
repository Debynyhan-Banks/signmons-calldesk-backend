import { controlledIntakeBrowserResult } from "./controlled-intake-browser-result";

describe("controlled intake refusal projection", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const value = {
    status: "REFUSED",
    reason: "VERIFICATION_LIMIT_REACHED",
    jobCreated: false,
  };
  it("projects only safe refusal fields and denies downstream authority", () => {
    expect(
      controlledIntakeBrowserResult(
        { ...value, providerBody: "private", heldMicros: 123 },
        requestId,
      ),
    ).toEqual({
      ...value,
      requestId,
      paymentAuthorized: false,
      bookingAuthorized: false,
      dispatchAuthorized: false,
      deliveryAuthorized: false,
    });
  });
  it.each([
    "ADDRESS_REVIEW_UNAVAILABLE",
    "SERVICE_AREA_NOT_CONFIRMED",
    "OUTSIDE_SERVICE_AREA",
    "ADDRESS_CORRECTION_STATE_UNAVAILABLE",
  ] as const)("projects the safe refusal category %s", (reason) => {
    expect(
      controlledIntakeBrowserResult(
        {
          status: "REFUSED",
          reason,
          jobCreated: false,
          providerBody: "private",
        },
        requestId,
      ),
    ).toEqual({
      status: "REFUSED",
      reason,
      requestId,
      jobCreated: false,
      paymentAuthorized: false,
      bookingAuthorized: false,
      dispatchAuthorized: false,
      deliveryAuthorized: false,
    });
  });
  it.each([
    { jobCreated: true },
    { requestId: "foreign" },
    { bookingAuthorized: true },
    { reason: "untrusted" },
    { reason: "OUTSIDE_SERVICE_AREA", status: "UNCERTAIN" },
    { status: "UNCERTAIN" },
  ])("rejects contradictory or untrusted refusal (%j)", (patch) => {
    expect(() =>
      controlledIntakeBrowserResult({ ...value, ...patch }, requestId),
    ).toThrow();
  });
  it("preserves an uncertain result without inventing a refusal reason", () => {
    expect(
      controlledIntakeBrowserResult(
        { status: "UNCERTAIN", jobCreated: false },
        requestId,
      ),
    ).toMatchObject({ status: "UNCERTAIN", jobCreated: false });
  });

  it("projects only an opaque correction continuation with a safe candidate", () => {
    const correctionContinuation = "v1." + "a".repeat(80);
    expect(
      controlledIntakeBrowserResult(
        {
          status: "CORRECTION_REQUIRED",
          jobCreated: false,
          correctionContinuation,
          candidate: {
            addressLines: ["124 Fictional Lane"],
            city: "Example",
            postalCode: "44101",
            country: "US",
            state: "OH",
            responseId: "private",
          },
        },
        requestId,
      ),
    ).toMatchObject({
      status: "CORRECTION_REQUIRED",
      correctionContinuation,
      candidate: { addressLines: ["124 Fictional Lane"] },
    });
  });

  it("refuses missing/malformed or misplaced correction continuations", () => {
    const candidate = {
      addressLines: ["124 Fictional Lane"],
      city: "Example",
      postalCode: "44101",
      country: "US",
      state: "OH",
    };
    for (const value of [
      { status: "CORRECTION_REQUIRED", jobCreated: false, candidate },
      {
        status: "CORRECTION_REQUIRED",
        jobCreated: false,
        candidate,
        correctionContinuation: "raw-provider-id",
      },
      {
        status: "REFUSED",
        reason: "ADDRESS_REVIEW_UNAVAILABLE",
        jobCreated: false,
        correctionContinuation: "v1." + "a".repeat(80),
      },
    ])
      expect(() => controlledIntakeBrowserResult(value, requestId)).toThrow();
  });
});
