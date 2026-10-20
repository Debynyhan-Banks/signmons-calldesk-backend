import {
  GoogleAddressAdapter,
  reviewGoogleAddressResponse,
} from "./google-address.adapter";

describe("disabled Google address adapter", () => {
  const input = {
    street: "123 Fictional Street",
    city: "Example",
    postalCode: "44101",
    unit: "",
  };
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
        addressComponents: [
          "street_number",
          "route",
          "locality",
          "administrative_area_level_1",
          "postal_code",
          "country",
        ].map((componentType) => ({
          componentType,
          componentName: {
            text: (
              {
                street_number: "123",
                route: "Fictional Street",
                locality: "Example",
                administrative_area_level_1: "Ohio",
                postal_code: "44101",
                country: "United States",
              } as Record<string, string>
            )[componentType],
          },
          confirmationLevel: "CONFIRMED",
        })),
      },
      uspsData: { dpvConfirmation: "Y" },
    },
    responseId: "never-return-this",
  });
  it("is disabled without a fixture, even with valid input", async () => {
    expect(await new GoogleAddressAdapter().validate(input)).toMatchObject({
      status: "DISABLED",
      admissionAuthorized: false,
    });
  });
  it("reviews a supplied response without transport or fixture provenance", () => {
    const value = response();
    const before = JSON.stringify(value);
    const reviewed = reviewGoogleAddressResponse(input, value);
    expect(reviewed.status).toBe("REVIEW");
    expect(reviewed).not.toHaveProperty("fixtureOnly");
    expect(reviewed).toMatchObject({
      addressVerified: false,
      admissionAuthorized: false,
    });
    expect(JSON.stringify(reviewed)).not.toContain("never-return-this");
    expect(JSON.stringify(value)).toBe(before);
    reviewed.candidate!.addressLines[0] = "changed";
    expect(JSON.stringify(value)).toBe(before);
  });
  it.each([null, {}, { ...input, street: "" }, { ...input, unit: 2 }])(
    "direct review refuses malformed input %j",
    (value) =>
      expect(reviewGoogleAddressResponse(value, response()).status).toBe(
        "INVALID_INPUT",
      ),
  );
  it.each([null, {}, { error: "private-provider-error" }])(
    "direct review strips unavailable responses %j",
    (value) => {
      expect(reviewGoogleAddressResponse(input, value)).toEqual({
        status: "UNKNOWN",
        candidate: null,
        addressVerified: false,
        admissionAuthorized: false,
      });
    },
  );
  it("maps only the minimal direct US/OH request and strips provider content", async () => {
    const mock = jest.fn().mockResolvedValue(response());
    const result = await new GoogleAddressAdapter(mock).validate(input);
    expect(mock).toHaveBeenCalledWith({
      address: {
        regionCode: "US",
        administrativeArea: "OH",
        locality: "Example",
        postalCode: "44101",
        addressLines: ["123 Fictional Street"],
      },
      enableUspsCass: true,
    });
    expect(result).toEqual({
      status: "REVIEW",
      fixtureOnly: true,
      addressVerified: false,
      county: "UNKNOWN",
      admissionAuthorized: false,
    });
  });
  it.each([
    null,
    {},
    { ...input, unit: null },
    { ...input, street: " bad" },
    { ...input, postalCode: "ABC" },
    { ...input, regionCode: "CA" },
    { ...input, city: "bad\ncity" },
  ])("refuses invalid input without calling transport", async (value) => {
    const mock = jest.fn();
    expect((await new GoogleAddressAdapter(mock).validate(value)).status).toBe(
      "INVALID_INPUT",
    );
    expect(mock).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { result: {} },
    { result: { verdict: { addressComplete: true } } },
  ])("refuses incomplete response", async (value) => {
    expect(
      (
        await new GoogleAddressAdapter(() => Promise.resolve(value)).validate(
          input,
        )
      ).status,
    ).toBe("UNKNOWN");
  });
  it.each(["N", "D", "S", ""])(
    "refuses nonconfirmed DPV %s",
    async (dpvConfirmation) => {
      const value = response();
      value.result.uspsData.dpvConfirmation = dpvConfirmation;
      expect(
        (
          await new GoogleAddressAdapter(() => Promise.resolve(value)).validate(
            input,
          )
        ).status,
      ).toBe("UNKNOWN");
    },
  );
  it("requires subpremise validation when a unit is supplied", async () => {
    expect(
      (
        await new GoogleAddressAdapter(() =>
          Promise.resolve(response()),
        ).validate({
          ...input,
          unit: "Unit 2",
        })
      ).status,
    ).toBe("UNKNOWN");
  });
  it("redacts errors and never retries", async () => {
    const mock = jest
      .fn()
      .mockRejectedValue(new Error("private address secret"));
    const result = await new GoogleAddressAdapter(mock).validate(input);
    expect(result.status).toBe("UNKNOWN");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it.each([
    "missingComponentTypes",
    "unconfirmedComponentTypes",
    "unresolvedTokens",
  ])("refuses contradictory %s despite complete verdict", async (key) => {
    const value = response();
    Object.assign(value.result.address, { [key]: ["unresolved"] });
    expect(
      (
        await new GoogleAddressAdapter(() => Promise.resolve(value)).validate(
          input,
        )
      ).status,
    ).toBe("UNKNOWN");
  });
  it.each([null, {}, "false", 0])(
    "refuses malformed optional flags %p",
    async (flag) => {
      const value = response();
      Object.assign(value.result.verdict, { hasUnconfirmedComponents: flag });
      expect(
        (
          await new GoogleAddressAdapter(() => Promise.resolve(value)).validate(
            input,
          )
        ).status,
      ).toBe("UNKNOWN");
    },
  );
  it.each([
    "street_number",
    "route",
    "locality",
    "administrative_area_level_1",
    "postal_code",
    "country",
  ])("requires %s component", async (type) => {
    const value = response();
    value.result.address.addressComponents =
      value.result.address.addressComponents.filter(
        (c) => c.componentType !== type,
      );
    expect(
      (
        await new GoogleAddressAdapter(() => Promise.resolve(value)).validate(
          input,
        )
      ).status,
    ).toBe("UNKNOWN");
  });
  it.each([
    "UNCONFIRMED_BUT_PLAUSIBLE",
    "UNCONFIRMED_AND_SUSPICIOUS",
    "",
    "NEW_ENUM",
  ])("refuses component confirmation %s", async (confirmationLevel) => {
    const value = response();
    value.result.address.addressComponents[0].confirmationLevel =
      confirmationLevel;
    expect(
      (
        await new GoogleAddressAdapter(() => Promise.resolve(value)).validate(
          input,
        )
      ).status,
    ).toBe("UNKNOWN");
  });
  it("refuses duplicate component types", async () => {
    const value = response();
    value.result.address.addressComponents.push(
      value.result.address.addressComponents[0],
    );
    expect(
      (
        await new GoogleAddressAdapter(() => Promise.resolve(value)).validate(
          input,
        )
      ).status,
    ).toBe("UNKNOWN");
  });
  it("accepts unordered confirmed components only for nonauthoritative review", async () => {
    const value = response();
    value.result.address.addressComponents.reverse();
    const result = await new GoogleAddressAdapter(() =>
      Promise.resolve(value),
    ).validate(input);
    expect(result.status).toBe("REVIEW");
    expect(result.admissionAuthorized).toBe(false);
    expect(result.addressVerified).toBe(false);
  });
  it("requires confirmed subpremise component and granular validation together", async () => {
    const value = response();
    value.result.verdict.validationGranularity = "SUB_PREMISE";
    value.result.address.postalAddress.addressLines.push("Unit 2");
    value.result.address.addressComponents.push({
      componentType: "subpremise",
      componentName: { text: "2" },
      confirmationLevel: "CONFIRMED",
    });
    expect(
      (
        await new GoogleAddressAdapter(() => Promise.resolve(value)).validate({
          ...input,
          unit: "Unit 2",
        })
      ).status,
    ).toBe("REVIEW");
  });
  it.each([
    ["street_number", "124"],
    ["route", "Different Street"],
    ["subpremise", "3"],
  ])("requires correction for changed %s", async (type, name) => {
    const value = response();
    const found = value.result.address.addressComponents.find(
      (c) => c.componentType === type,
    );
    if (found) found.componentName.text = name;
    else {
      value.result.verdict.validationGranularity = "SUB_PREMISE";
      value.result.address.addressComponents.push({
        componentType: type,
        componentName: { text: name },
        confirmationLevel: "CONFIRMED",
      });
    }
    const result = await new GoogleAddressAdapter(() =>
      Promise.resolve(value),
    ).validate(input);
    expect(result.status).toBe("CORRECTION_REQUIRED");
    expect(result.addressVerified).toBe(false);
    expect(result.admissionAuthorized).toBe(false);
  });
  it.each([
    "hasInferredComponents",
    "hasReplacedComponents",
    "hasSpellCorrectedComponents",
  ])("requires explicit correction review for %s", async (key) => {
    const value = response();
    Object.assign(value.result.verdict, { [key]: true });
    expect(
      (
        await new GoogleAddressAdapter(() => Promise.resolve(value)).validate(
          input,
        )
      ).status,
    ).toBe("CORRECTION_REQUIRED");
  });
  it.each([
    ["locality", "Other City"],
    ["postalCode", "44102"],
  ])("does not silently accept changed %s", async (key, changed) => {
    const value = response();
    Object.assign(value.result.address.postalAddress, { [key]: changed });
    expect(
      (
        await new GoogleAddressAdapter(() => Promise.resolve(value)).validate(
          input,
        )
      ).status,
    ).toBe("CORRECTION_REQUIRED");
  });
  it("still requires customer review of changed postal lines", async () => {
    const value = response();
    value.result.address.postalAddress.addressLines = ["123 Fictional St"];
    expect(
      (
        await new GoogleAddressAdapter(() => Promise.resolve(value)).validate(
          input,
        )
      ).status,
    ).toBe("CORRECTION_REQUIRED");
  });
  it.each(["street", "postalCode"] as const)(
    "reviews the selected %s only when its structured representation agrees",
    (field) => {
      const value = response();
      if (field === "street")
        value.result.address.postalAddress.addressLines = ["123 Fictional St"];
      else value.result.address.postalAddress.postalCode = "44101-1234";

      const first = reviewGoogleAddressResponse(input, value);
      expect(first.status).toBe("CORRECTION_REQUIRED");
      const candidate = first.candidate!;
      const second = reviewGoogleAddressResponse(
        {
          ...input,
          street: candidate.addressLines[0],
          city: candidate.city,
          postalCode: candidate.postalCode,
        },
        value,
      );

      // The approved suffix pair resolves street spelling after postal review.
      // ZIP+4 without a provider suffix remains a genuine evidence mismatch.
      expect(second).toMatchObject({
        status: field === "street" ? "REVIEW" : "CORRECTION_REQUIRED",
        candidate,
        addressVerified: false,
        admissionAuthorized: false,
      });
      expect(JSON.stringify(second)).not.toContain("never-return-this");
    },
  );
  it("preserves case and whitespace normalization without correction", async () => {
    const value = response();
    value.result.address.postalAddress.addressLines = ["123  FICTIONAL STREET"];
    expect(
      (
        await new GoogleAddressAdapter(() => Promise.resolve(value)).validate(
          input,
        )
      ).status,
    ).toBe("REVIEW");
  });

  const component = (value: ReturnType<typeof response>, type: string) =>
    value.result.address.addressComponents.find(
      (c) => c.componentType === type,
    )!;
  const suffix = (value: ReturnType<typeof response>, text = "1234") =>
    value.result.address.addressComponents.push({
      componentType: "postal_code_suffix",
      componentName: { text },
      confirmationLevel: "CONFIRMED",
    });

  it.each([false, true])(
    "assembles confirmed split ZIP components, already complete=%s",
    (complete) => {
      const value = response();
      const postalCode = "44101-1234";
      value.result.address.postalAddress.postalCode = postalCode;
      if (complete)
        component(value, "postal_code").componentName.text = postalCode;
      suffix(value);
      expect(reviewGoogleAddressResponse(input, value).status).toBe(
        "CORRECTION_REQUIRED",
      );
      expect(
        reviewGoogleAddressResponse({ ...input, postalCode }, value),
      ).toMatchObject({
        status: "REVIEW",
        addressVerified: false,
        admissionAuthorized: false,
      });
    },
  );
  it("accepts an already complete component ZIP without inventing another suffix", () => {
    const value = response();
    const postalCode = "44101-1234";
    value.result.address.postalAddress.postalCode = postalCode;
    component(value, "postal_code").componentName.text = postalCode;
    expect(
      reviewGoogleAddressResponse({ ...input, postalCode }, value).status,
    ).toBe("REVIEW");
  });
  it.each([
    ["44101", "123", "44101-1234"],
    ["44101", "12345", "44101-1234"],
    ["44101", "ABCD", "44101-1234"],
    ["44101", " 1234", "44101-1234"],
    ["44101-9999", "1234", "44101-9999"],
    ["44102", "1234", "44101-1234"],
    ["44101", "9999", "44101-1234"],
    ["44101", "1234", "44101"],
    ["441011234", undefined, "44101-1234"],
    ["44101", undefined, "44101-1234"],
  ])(
    "does not ignore ZIP component/suffix conflict: %s %s %s",
    (base, extension, postalCode) => {
      const value = response();
      value.result.address.postalAddress.postalCode = postalCode;
      component(value, "postal_code").componentName.text = base;
      if (extension !== undefined) suffix(value, extension);
      const result = reviewGoogleAddressResponse(
        { ...input, postalCode },
        value,
      );
      expect(result.status).not.toBe("REVIEW");
      expect(result.admissionAuthorized).toBe(false);
    },
  );
  it.each([
    "duplicate",
    "unconfirmed",
    "inferred",
    "replaced",
    "spellCorrected",
  ])("does not ignore %s suffix evidence", (change) => {
    const value = response();
    const postalCode = "44101-1234";
    value.result.address.postalAddress.postalCode = postalCode;
    suffix(value);
    if (change === "duplicate") suffix(value);
    else if (change === "unconfirmed")
      component(value, "postal_code_suffix").confirmationLevel =
        "UNCONFIRMED_BUT_PLAUSIBLE";
    else
      Object.assign(component(value, "postal_code_suffix"), { [change]: true });
    expect(
      reviewGoogleAddressResponse({ ...input, postalCode }, value).status,
    ).not.toBe("REVIEW");
  });
  it.each([
    ["STREET", "ST"],
    ["AVENUE", "AVE"],
    ["ROAD", "RD"],
    ["BOULEVARD", "BLVD"],
    ["DRIVE", "DR"],
    ["LANE", "LN"],
    ["COURT", "CT"],
    ["CIRCLE", "CIR"],
    ["PARKWAY", "PKWY"],
    ["PLACE", "PL"],
    ["TERRACE", "TER"],
    ["TRAIL", "TRL"],
  ])(
    "reviews approved final suffix %s/%s only after exact postal selection",
    (full, abbreviated) => {
      for (const [routeSuffix, postalSuffix] of [
        [full, abbreviated],
        [abbreviated, full],
      ]) {
        const value = response();
        const original = { ...input, street: `123 Fictional ${routeSuffix}` };
        const street = `123 Fictional ${postalSuffix}`;
        component(value, "route").componentName.text =
          `Fictional ${routeSuffix}`;
        value.result.address.postalAddress.addressLines = [street];
        expect(reviewGoogleAddressResponse(original, value).status).toBe(
          "CORRECTION_REQUIRED",
        );
        expect(
          reviewGoogleAddressResponse({ ...input, street }, value),
        ).toMatchObject({
          status: "REVIEW",
          addressVerified: false,
          admissionAuthorized: false,
        });
      }
    },
  );
  it.each([
    ["123 Fictional St", "124", "Fictional Street"],
    ["123 Fictional St", "123", "Different Street"],
    ["123 Fictional St", "123", "Fictional Road"],
    ["123 Fictional Strt", "123", "Fictional Street"],
    ["123 Fictional St.", "123", "Fictional Street"],
    ["123 East Fictional St", "123", "West Fictional Street"],
    ["123 E Fictional St", "123", "East Fictional Street"],
    ["123 St John St", "123", "Saint John Street"],
    ["123 Road Street", "123", "Rd Street"],
    ["123 St", "123", "Street"],
    ["123 1/2 St", "123 1/2", "Street"],
    ["123 Fictional toString", "123", "Fictional Street"],
  ])(
    "does not normalize other street differences: %s / %s %s",
    (street, number, route) => {
      const value = response();
      value.result.address.postalAddress.addressLines = [street];
      component(value, "street_number").componentName.text = number;
      component(value, "route").componentName.text = route;
      expect(
        reviewGoogleAddressResponse({ ...input, street }, value).status,
      ).toBe("CORRECTION_REQUIRED");
    },
  );
  it("requires the same unit after suffix review and supports split postal lines", () => {
    const value = response();
    const reviewed = { ...input, street: "123 Fictional St", unit: "Unit 2" };
    value.result.verdict.validationGranularity = "SUB_PREMISE";
    value.result.address.postalAddress.addressLines = [
      reviewed.street,
      reviewed.unit,
    ];
    value.result.address.addressComponents.push({
      componentType: "subpremise",
      componentName: { text: "2" },
      confirmationLevel: "CONFIRMED",
    });
    expect(reviewGoogleAddressResponse(reviewed, value).status).toBe("REVIEW");
    component(value, "subpremise").componentName.text = "3";
    expect(reviewGoogleAddressResponse(reviewed, value).status).toBe(
      "CORRECTION_REQUIRED",
    );
    expect(
      reviewGoogleAddressResponse({ ...reviewed, unit: "" }, value).status,
    ).not.toBe("REVIEW");
  });
});
