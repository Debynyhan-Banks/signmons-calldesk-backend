import { evaluateGoogleServiceArea } from "./google-service-area";

describe("Google service-area fixture evaluator", () => {
  const input = {
    street: "123 Fictional Street",
    city: "Example",
    postalCode: "44101",
    unit: "",
  };
  const binding = {
    tenantId: "fixture-tenant",
    sessionId: "fixture-session",
    addressRevision: 1,
    policyVersion: "fixture-v1",
  };
  const context = () => ({
    current: { ...binding },
    confirmed: { ...binding },
    customerConfirmed: true,
    checkedAt: 100,
    now: 200,
    expiresAt: 300,
  });
  const response = () => ({
    result: {
      verdict: { addressComplete: true, validationGranularity: "PREMISE" },
      address: {
        postalAddress: {
          regionCode: "US",
          administrativeArea: "OH",
          locality: "Example",
          postalCode: "44101",
          addressLines: ["123 Fictional Street"],
        },
        addressComponents: Object.entries({
          street_number: "123",
          route: "Fictional Street",
          locality: "Example",
          administrative_area_level_1: "Ohio",
          postal_code: "44101",
          country: "United States",
        }).map(([componentType, text]) => ({
          componentType,
          componentName: { text },
          confirmationLevel: "CONFIRMED",
        })),
      },
      uspsData: {
        dpvConfirmation: "Y",
        dpvCmra: "N",
        poBoxOnlyPostalCode: false,
        addressRecordType: "H",
        fipsCountyCode: "035",
        county: "Cuyahoga",
      },
      metadata: { poBox: false },
    },
  });
  const run = (r: unknown = response(), c = context(), i = input) =>
    evaluateGoogleServiceArea(i, r, c, "FIXTURE_ONLY");
  it("defaults disabled", async () => {
    expect(
      (await evaluateGoogleServiceArea(input, response(), context())).coverage,
    ).toBe("UNKNOWN");
  });
  it("proposes inside without granting authority or exposing content", async () => {
    expect(await run()).toEqual({
      coverage: "IN_AREA",
      fixtureOnly: true,
      realVerificationAccepted: false,
      admissionAuthorized: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    });
  });
  it.each([
    ["093", "Lorain"],
    ["103", "Medina"],
    ["153", "Summit"],
  ])("uses structured county not the same ZIP: %s", async (code, name) => {
    const r = response();
    r.result.uspsData.fipsCountyCode = code;
    r.result.uspsData.county = name;
    expect((await run(r)).coverage).toBe("OUT_OF_AREA");
  });
  it.each(["", "39035", "35", "999", "toString"])(
    "refuses unqualified/missing code %s",
    async (code) => {
      const r = response();
      r.result.uspsData.fipsCountyCode = code;
      expect((await run(r)).coverage).toBe("UNKNOWN");
    },
  );
  it.each([
    { county: "Lorain" },
    { county: "" },
    { dpvConfirmation: "D" },
    { dpvConfirmation: "S" },
    { dpvCmra: "Y" },
    { dpvCmra: "" },
    { addressRecordType: "P" },
    { addressRecordType: "R" },
    { poBoxOnlyPostalCode: true },
    { pmbNumber: "12" },
    { pmbDesignator: "PMB" },
  ])("refuses conflicting/nonphysical/unit evidence %j", async (patch) => {
    const r = response();
    Object.assign(r.result.uspsData, patch);
    expect((await run(r)).coverage).toBe("UNKNOWN");
  });
  it.each([
    "tenantId",
    "sessionId",
    "policyVersion",
    "addressRevision",
  ] as const)("rejects stale %s", async (key) => {
    const c = context();
    Object.assign(c.confirmed, {
      [key]: key === "addressRevision" ? 2 : "stale",
    });
    expect((await run(response(), c)).coverage).toBe("UNKNOWN");
  });
  it.each([
    { customerConfirmed: false },
    { now: 300 },
    { checkedAt: 201 },
    { expiresAt: 86400200 },
    { now: NaN },
  ])("rejects confirmation/time %j", async (patch) => {
    expect((await run(response(), { ...context(), ...patch })).coverage).toBe(
      "UNKNOWN",
    );
  });
  it("refuses wrong state/country and component conflicts", async () => {
    for (const key of ["regionCode", "administrativeArea"]) {
      const r = response();
      Object.assign(r.result.address.postalAddress, { [key]: "WRONG" });
      expect((await run(r)).coverage).toBe("UNKNOWN");
    }
    const r = response();
    r.result.address.addressComponents[3].componentName.text = "Oregon";
    expect((await run(r)).coverage).toBe("UNKNOWN");
  });
  it("refuses unconfirmed unit or changed address", async () => {
    expect(
      (await run(response(), context(), { ...input, unit: "2" })).coverage,
    ).toBe("UNKNOWN");
    expect(
      (
        await run(response(), context(), {
          ...input,
          street: "124 Fictional Street",
        })
      ).coverage,
    ).toBe("UNKNOWN");
  });
  it("accepts a fully resolved and confirmed unit as a proposal", async () => {
    const r = response();
    r.result.verdict.validationGranularity = "SUB_PREMISE";
    r.result.address.postalAddress.addressLines.push("Unit 2");
    r.result.address.addressComponents.push({
      componentType: "subpremise",
      componentName: { text: "2" },
      confirmationLevel: "CONFIRMED",
    });
    expect(
      (await run(r, context(), { ...input, unit: "Unit 2" })).coverage,
    ).toBe("IN_AREA");
  });
  it("refuses missing physical-location flags", async () => {
    const r = response();
    Reflect.deleteProperty(r.result.metadata, "poBox");
    expect((await run(r)).coverage).toBe("UNKNOWN");
  });
  it.each([null, {}, { error: "provider failure" }])(
    "refuses unavailable responses",
    async (r) => {
      expect((await run(r)).coverage).toBe("UNKNOWN");
    },
  );
  it("does not mutate inputs or depend on post-yield mutations", async () => {
    const r = response();
    const c = context();
    const promise = run(r, c);
    r.result.uspsData.county = "Lorain";
    c.current.tenantId = "changed";
    expect((await promise).coverage).toBe("IN_AREA");
    expect(input.street).toBe("123 Fictional Street");
  });
});
