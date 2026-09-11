import { localAddressReviewSnapshot } from "./local-address-review-snapshot";

describe("historical local address review snapshot", () => {
  const valid = {
    fixtureOnly: true,
    revision: 2,
    candidateId: "fixture",
    query: "Fictional",
    unit: "Unit A",
    address: "10 Fictional Lane, Unit A",
    coverage: "FIXTURE_IN_AREA",
    addressAuthorized: false,
    bookingAuthorized: false,
    deliveryAuthorized: false,
  };
  it.each(["FIXTURE_IN_AREA", "OUT_OF_AREA", "UNKNOWN"])(
    "retains %s without authority",
    (coverage) => {
      expect(localAddressReviewSnapshot({ ...valid, coverage })).toEqual({
        ...valid,
        coverage,
      });
    },
  );
  it.each([
    { fixtureOnly: false },
    { addressAuthorized: true },
    { bookingAuthorized: true },
    { deliveryAuthorized: true },
    { revision: 0 },
    { revision: 21 },
    { revision: 1.5 },
    { unit: "x".repeat(41) },
    { query: "" },
    { address: "x".repeat(201) },
    { address: "Leading " },
    { unit: "hidden\u0000" },
    { candidateId: "INVALID" },
    { coverage: "VERIFIED" },
    { newPermission: true },
  ])("refuses malformed or authority-bearing snapshot %#", (override) => {
    expect(() =>
      localAddressReviewSnapshot({ ...valid, ...override }),
    ).toThrow();
  });
});
