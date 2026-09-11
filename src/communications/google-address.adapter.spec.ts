import { GoogleAddressAdapter } from "./google-address.adapter";

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
          componentName: { text: "Fixture" },
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
    Object.assign(value.result.verdict, { hasReplacedComponents: true });
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
});
