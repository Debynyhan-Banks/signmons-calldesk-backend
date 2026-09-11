export type GoogleAddressRequest = {
  address: {
    regionCode: "US";
    administrativeArea: "OH";
    locality: string;
    postalCode: string;
    addressLines: string[];
  };
  enableUspsCass: true;
};

type FixtureTransport = (request: GoogleAddressRequest) => Promise<unknown>;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  !/[\p{Cc}\p{Cf}]/u.test(value);

/** No HTTP client, credentials, environment switch or production registration.
 * The injected fixture seam exercises the wire contract, never real verification.
 */
export class GoogleAddressAdapter {
  constructor(private readonly fixture?: FixtureTransport) {}

  async validate(input: unknown) {
    const result = (
      status: "DISABLED" | "INVALID_INPUT" | "UNKNOWN" | "REVIEW",
    ) => ({
      status,
      fixtureOnly: true as const,
      addressVerified: false as const,
      county: "UNKNOWN" as const,
      admissionAuthorized: false as const,
    });
    if (!this.fixture) return result("DISABLED");
    const data = record(input);
    if (
      Object.keys(data).sort().join(",") !== "city,postalCode,street,unit" ||
      !text(data.street, 150) ||
      !text(data.city, 60) ||
      typeof data.unit !== "string" ||
      (data.unit !== "" && !text(data.unit, 30)) ||
      typeof data.postalCode !== "string" ||
      !/^\d{5}(-\d{4})?$/.test(data.postalCode) ||
      data.street.length +
        data.city.length +
        data.unit.length +
        data.postalCode.length +
        4 >
        280
    )
      return result("INVALID_INPUT");
    const request: GoogleAddressRequest = {
      address: {
        regionCode: "US",
        administrativeArea: "OH",
        locality: data.city,
        postalCode: data.postalCode,
        addressLines: [data.street, ...(data.unit ? [data.unit] : [])],
      },
      enableUspsCass: true,
    };
    try {
      const response = record(await this.fixture(request));
      const body = record(response.result);
      const verdict = record(body.verdict);
      const address = record(body.address);
      const postal = record(address.postalAddress);
      const usps = record(body.uspsData);
      // REVIEW is only a fixture result, not customer confirmation or proof.
      if (
        verdict.addressComplete !== true ||
        verdict.hasUnconfirmedComponents === true ||
        !["PREMISE", "SUB_PREMISE"].includes(
          String(verdict.validationGranularity),
        ) ||
        (data.unit !== "" && verdict.validationGranularity !== "SUB_PREMISE") ||
        postal.regionCode !== "US" ||
        postal.administrativeArea !== "OH" ||
        usps.dpvConfirmation !== "Y"
      )
        return result("UNKNOWN");
      return result("REVIEW");
    } catch {
      // Do not leak provider errors or retry an uncertain operation.
      return result("UNKNOWN");
    }
  }
}
