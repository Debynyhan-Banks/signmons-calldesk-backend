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
export type AddressCorrectionCandidate = {
  addressLines: string[];
  city: string;
  postalCode: string;
  country: "US";
  state: "OH";
};
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
    const preview = await this.preview(input);
    return {
      status: preview.status,
      fixtureOnly: preview.fixtureOnly,
      addressVerified: preview.addressVerified,
      county: preview.county,
      admissionAuthorized: preview.admissionAuthorized,
    };
  }

  /** Transient correction-display fields only; never a verification receipt. */
  async preview(input: unknown) {
    const result = (
      status:
        | "DISABLED"
        | "INVALID_INPUT"
        | "UNKNOWN"
        | "REVIEW"
        | "CORRECTION_REQUIRED",
      candidate: AddressCorrectionCandidate | null = null,
    ) => ({
      status,
      fixtureOnly: true as const,
      addressVerified: false as const,
      county: "UNKNOWN" as const,
      admissionAuthorized: false as const,
      candidate,
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
    // Snapshot intended values before yielding to the fixture; never compare
    // against caller-owned objects that could change while awaiting a response.
    const intended = {
      street: data.street,
      city: data.city,
      postalCode: data.postalCode,
      unit: data.unit,
    };
    try {
      const response = record(await this.fixture(request));
      const body = record(response.result);
      const verdict = record(body.verdict);
      const address = record(body.address);
      const postal = record(address.postalAddress);
      const usps = record(body.uspsData);
      const components = address.addressComponents;
      const emptyList = (value: unknown) =>
        value === undefined || (Array.isArray(value) && value.length === 0);
      const optionalBoolean = (value: unknown) =>
        value === undefined || typeof value === "boolean";
      const types = new Set<string>();
      const validComponents =
        Array.isArray(components) &&
        components.length > 0 &&
        components.length <= 30 &&
        components.every((value: unknown) => {
          const component = record(value);
          if (
            !text(component.componentType, 80) ||
            types.has(component.componentType) ||
            !text(record(component.componentName).text, 200) ||
            component.confirmationLevel !== "CONFIRMED" ||
            component.unexpected === true ||
            !["inferred", "replaced", "spellCorrected", "unexpected"].every(
              (key) => optionalBoolean(component[key]),
            )
          )
            return false;
          types.add(component.componentType);
          return true;
        }) &&
        [
          "street_number",
          "route",
          "locality",
          "administrative_area_level_1",
          "postal_code",
          "country",
        ].every((type) => types.has(type));
      // REVIEW is only a fixture result, not customer confirmation or proof.
      if (
        !validComponents ||
        ![
          "missingComponentTypes",
          "unconfirmedComponentTypes",
          "unresolvedTokens",
        ].every((key) => emptyList(address[key])) ||
        ![
          "hasUnconfirmedComponents",
          "hasInferredComponents",
          "hasReplacedComponents",
          "hasSpellCorrectedComponents",
        ].every((key) => optionalBoolean(verdict[key])) ||
        verdict.addressComplete !== true ||
        verdict.hasUnconfirmedComponents === true ||
        !["PREMISE", "SUB_PREMISE"].includes(
          String(verdict.validationGranularity),
        ) ||
        (intended.unit !== "" &&
          verdict.validationGranularity !== "SUB_PREMISE") ||
        (intended.unit !== "" && !types.has("subpremise")) ||
        (types.has("subpremise") &&
          verdict.validationGranularity !== "SUB_PREMISE") ||
        postal.regionCode !== "US" ||
        postal.administrativeArea !== "OH" ||
        !text(postal.locality, 100) ||
        typeof postal.postalCode !== "string" ||
        !/^\d{5}(-\d{4})?$/.test(postal.postalCode) ||
        !Array.isArray(postal.addressLines) ||
        postal.addressLines.length === 0 ||
        postal.addressLines.length > 3 ||
        !postal.addressLines.every((line: unknown) => text(line, 200)) ||
        usps.dpvConfirmation !== "Y"
      )
        return result("UNKNOWN");
      const normalize = (value: string) =>
        value.toUpperCase().trim().replace(/\s+/g, " ");
      const names = new Map<string, string>(
        (components as Record<string, unknown>[]).map((component) => [
          component.componentType as string,
          record(component.componentName).text as string,
        ]),
      );
      const correction =
        normalize(intended.street) !==
          normalize(names.get("street_number") + " " + names.get("route")) ||
        normalize(intended.city) !== normalize(postal.locality) ||
        normalize(intended.city) !== normalize(names.get("locality") ?? "") ||
        intended.postalCode !== postal.postalCode ||
        intended.postalCode !== names.get("postal_code") ||
        !["OH", "OHIO"].includes(
          normalize(names.get("administrative_area_level_1") ?? ""),
        ) ||
        !["US", "USA", "UNITED STATES"].includes(
          normalize(names.get("country") ?? ""),
        ) ||
        normalize(
          [intended.street, intended.unit].filter(Boolean).join(" "),
        ) !== normalize(postal.addressLines.join(" ")) ||
        (intended.unit === ""
          ? types.has("subpremise")
          : normalize(intended.unit).replace(/^UNIT /, "") !==
            normalize(names.get("subpremise") ?? "")) ||
        [
          "hasInferredComponents",
          "hasReplacedComponents",
          "hasSpellCorrectedComponents",
        ].some((key) => verdict[key] === true) ||
        (components as Record<string, unknown>[]).some((component) =>
          ["inferred", "replaced", "spellCorrected"].some(
            (key) => component[key] === true,
          ),
        );
      const candidate: AddressCorrectionCandidate = {
        addressLines: [...postal.addressLines],
        city: postal.locality,
        postalCode: postal.postalCode,
        country: "US",
        state: "OH",
      };
      if (correction) return result("CORRECTION_REQUIRED", candidate);
      return result("REVIEW", candidate);
    } catch {
      // Do not leak provider errors or retry an uncertain operation.
      return result("UNKNOWN");
    }
  }
}
