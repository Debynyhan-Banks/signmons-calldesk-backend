import { localZipCoverage } from "./local-address.service";
describe("local explicit ZIP coverage", () => {
  const area = {
    id: "fixture",
    type: "ZIP",
    status: "ACTIVE",
    definition: { postalCodes: ["44119"] },
    updatedAt: new Date(),
  };
  it("requires explicit matching active geography", () => {
    expect(localZipCoverage([area], "44119")).toBe("FIXTURE_IN_AREA");
    expect(localZipCoverage([area], "44120")).toBe("OUT_OF_AREA");
    expect(
      localZipCoverage(
        [{ ...area, definition: { postalCodes: ["44119-1234"] } }],
        "44119",
      ),
    ).toBe("FIXTURE_IN_AREA");
  });
  it.each(
    [
      [],
      [{ ...area, status: "INACTIVE" }],
      [{ ...area, type: "POLYGON" }],
      [{ ...area, definition: {} }],
      [{ ...area, definition: null }],
      [{ ...area, definition: { postalCodes: [] } }],
      [{ ...area, definition: { postalCodes: ["44119bad"] } }],
      [area, { ...area, type: "POLYGON" }],
    ].map((areas) => ({ areas })),
  )("refuses missing/unsupported/malformed authority %j", ({ areas }) => {
    expect(localZipCoverage(areas, "44119")).toBe("UNKNOWN");
  });
  it.each(["", "44119-1234", "address 44119", "000", "4411x"])(
    "refuses unvalidated ZIP %s",
    (zip) => {
      expect(localZipCoverage([area], zip)).toBe("UNKNOWN");
    },
  );
});
