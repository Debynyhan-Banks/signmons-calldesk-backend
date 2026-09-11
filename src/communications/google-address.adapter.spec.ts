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
        postalAddress: { regionCode: "US", administrativeArea: "OH" },
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
});
