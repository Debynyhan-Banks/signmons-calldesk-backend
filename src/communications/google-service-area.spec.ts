import {
  evaluateGoogleServiceArea,
  reviewGoogleServiceArea,
} from "./google-service-area";

describe.each(["H", "S"])("Google service-area (%s)", (recordType) => {
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
        addressRecordType: recordType,
        fipsCountyCode: "035",
        county: "Cuyahoga",
      },
      metadata: { poBox: false },
    },
  });
  const correctedInput = {
    ...input,
    street: "123 Fictional St",
    postalCode: "44101-1234",
  };
  const correctedResponse = () => {
    const r = response();
    r.result.address.postalAddress.addressLines = [correctedInput.street];
    r.result.address.postalAddress.postalCode = correctedInput.postalCode;
    r.result.address.addressComponents.push({
      componentType: "postal_code_suffix",
      componentName: { text: "1234" },
      confirmationLevel: "CONFIRMED",
    });
    return r;
  };
  const run = (r: unknown = response(), c = context(), i = input) =>
    evaluateGoogleServiceArea(i, r, c, "FIXTURE_ONLY");
  it("defaults disabled", async () => {
    expect(
      (await evaluateGoogleServiceArea(input, response(), context())).coverage,
    ).toBe("UNKNOWN");
  });
  it("shares review semantics without claiming fixture or live acceptance", async () => {
    const reviewed = await reviewGoogleServiceArea(
      input,
      response(),
      context(),
      "REVIEW_ONLY",
    );
    expect(reviewed.coverage).toBe("IN_AREA");
    expect(reviewed).not.toHaveProperty("fixtureOnly");
    expect(reviewed).toMatchObject({
      realVerificationAccepted: false,
      admissionAuthorized: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    });
    expect(
      (await reviewGoogleServiceArea(input, response(), context())).coverage,
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
  it("proposes inside for the confirmed postal suffix and assembled ZIP without granting authority", async () => {
    expect(
      await reviewGoogleServiceArea(
        correctedInput,
        correctedResponse(),
        context(),
        "REVIEW_ONLY",
      ),
    ).toEqual({
      coverage: "IN_AREA",
      realVerificationAccepted: false,
      admissionAuthorized: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    });
    expect((await run(correctedResponse())).coverage).toBe("UNKNOWN");
  });
  it.each([
    ["route", "Different Street"],
    ["postal_code", "44102"],
    ["postal_code_suffix", "9999"],
  ])(
    "rejects a corrected-format response with conflicting %s",
    async (key, value) => {
      const r = correctedResponse();
      r.result.address.addressComponents.find(
        (component) => component.componentType === key,
      )!.componentName.text = value;
      expect((await run(r, context(), correctedInput)).coverage).toBe(
        "UNKNOWN",
      );
    },
  );
  it.each([
    ["093", "Lorain"],
    ["103", "Medina"],
    ["153", "Summit"],
  ])("uses structured county not the same ZIP: %s", async (code, name) => {
    for (const [r, i] of [
      [response(), input],
      [correctedResponse(), correctedInput],
    ] as const) {
      r.result.uspsData.fipsCountyCode = code;
      r.result.uspsData.county = name;
      expect((await run(r, context(), i)).coverage).toBe("OUT_OF_AREA");
    }
  });
  it.each([
    undefined,
    null,
    "",
    "F",
    "G",
    "P",
    "R",
    "h",
    "s",
    " S ",
    0,
    {},
    ["S"],
  ])("refuses unsupported or malformed record type %j", async (value) => {
    const r = response();
    Object.assign(r.result.uspsData, { addressRecordType: value });
    expect((await run(r)).coverage).toBe("UNKNOWN");
  });
  it.each(["fipsCountyCode", "county"])(
    "refuses missing structured county evidence %s",
    async (key) => {
      const r = response();
      Reflect.deleteProperty(r.result.uspsData, key);
      expect((await run(r)).coverage).toBe("UNKNOWN");
    },
  );
  it("refuses explicit PO-box metadata even with a supported record type", async () => {
    const r = response();
    r.result.metadata.poBox = true;
    expect((await run(r)).coverage).toBe("UNKNOWN");
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
    for (const [r, i] of [
      [response(), input],
      [correctedResponse(), correctedInput],
    ] as const) {
      Object.assign(r.result.uspsData, patch);
      expect((await run(r, context(), i)).coverage).toBe("UNKNOWN");
    }
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
    expect((await run(correctedResponse(), c, correctedInput)).coverage).toBe(
      "UNKNOWN",
    );
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
    expect(
      (
        await run(
          correctedResponse(),
          { ...context(), ...patch },
          correctedInput,
        )
      ).coverage,
    ).toBe("UNKNOWN");
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
  it("requires a resolved matching unit with the corrected street and ZIP", async () => {
    const r = correctedResponse();
    const i = { ...correctedInput, unit: "Unit 2" };
    expect((await run(r, context(), i)).coverage).toBe("UNKNOWN");
    r.result.verdict.validationGranularity = "SUB_PREMISE";
    r.result.address.postalAddress.addressLines.push(i.unit);
    const unit = {
      componentType: "subpremise",
      componentName: { text: "2" },
      confirmationLevel: "CONFIRMED",
    };
    r.result.address.addressComponents.push(unit);
    expect((await run(r, context(), i)).coverage).toBe("IN_AREA");
    unit.componentName.text = "3";
    expect((await run(r, context(), i)).coverage).toBe("UNKNOWN");
    unit.componentName.text = "2";
    unit.confirmationLevel = "UNCONFIRMED_BUT_PLAUSIBLE";
    expect((await run(r, context(), i)).coverage).toBe("UNKNOWN");
  });
  it("refuses missing physical-location flags", async () => {
    const r = response();
    Reflect.deleteProperty(r.result.metadata, "poBox");
    expect((await run(r)).coverage).toBe("UNKNOWN");
    const corrected = correctedResponse();
    Reflect.deleteProperty(corrected.result.metadata, "poBox");
    expect((await run(corrected, context(), correctedInput)).coverage).toBe(
      "UNKNOWN",
    );
  });
  it("accepts omitted proto3 false without treating optional metadata as false", async () => {
    const r = response();
    Reflect.deleteProperty(r.result.uspsData, "poBoxOnlyPostalCode");
    expect((await run(r)).coverage).toBe("IN_AREA");
    Reflect.deleteProperty(r.result.metadata, "poBox");
    expect((await run(r)).coverage).toBe("UNKNOWN");
  });
  it.each([null, 0, "", "false", {}, []])(
    "refuses malformed PO-box scalar %j",
    async (value) => {
      const r = response();
      Object.assign(r.result.uspsData, { poBoxOnlyPostalCode: value });
      expect((await run(r)).coverage).toBe("UNKNOWN");
    },
  );
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
