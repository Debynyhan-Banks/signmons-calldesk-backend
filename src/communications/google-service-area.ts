import { reviewGoogleAddressResponse } from "./google-address.adapter";

type Binding = {
  tenantId: string;
  sessionId: string;
  addressRevision: number;
  policyVersion: string;
};
type Context = {
  current: Binding;
  confirmed: Binding;
  customerConfirmed: boolean;
  checkedAt: number;
  expiresAt: number;
  now: number;
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Local fixture evaluation only. Not registered with a route or live provider.
 * Three-digit county format is documented in Google's examples, not live-qualified here.
 * Returned classifications are transient proposals, never durable proof.
 */
export async function evaluateGoogleServiceArea(
  input: unknown,
  response: unknown,
  context: Context,
  mode: "DISABLED" | "FIXTURE_ONLY" = "DISABLED",
) {
  const result = (coverage: "UNKNOWN" | "IN_AREA" | "OUT_OF_AREA") => ({
    coverage,
    fixtureOnly: true as const,
    realVerificationAccepted: false as const,
    admissionAuthorized: false as const,
    bookingAuthorized: false as const,
    deliveryAuthorized: false as const,
  });
  if (mode !== "FIXTURE_ONLY") return result("UNKNOWN");
  // Copy caller-owned input before the adapter's asynchronous fixture seam.
  try {
    const snapshot = structuredClone({ input, response, context });
    const c = record(snapshot.context);
    const current = record(c.current);
    const confirmed = record(c.confirmed);
    if (
      c.customerConfirmed !== true ||
      !["tenantId", "sessionId", "policyVersion"].every(
        (key) =>
          typeof current[key] === "string" &&
          current[key].trim().length > 0 &&
          current[key] === confirmed[key],
      ) ||
      !Number.isSafeInteger(current.addressRevision) ||
      (current.addressRevision as number) < 1 ||
      current.addressRevision !== confirmed.addressRevision ||
      ![c.now, c.checkedAt, c.expiresAt].every(
        (value) => Number.isSafeInteger(value) && (value as number) >= 0,
      ) ||
      (c.checkedAt as number) > (c.now as number) ||
      (c.now as number) >= (c.expiresAt as number) ||
      (c.expiresAt as number) - (c.checkedAt as number) > 86400000
    )
      return result("UNKNOWN");

    const preview = await Promise.resolve(
      reviewGoogleAddressResponse(snapshot.input, snapshot.response),
    );
    if (preview.status !== "REVIEW") return result("UNKNOWN");
    const body = record(record(snapshot.response).result);
    const usps = record(body.uspsData);
    const metadata = record(body.metadata);
    // Optional metadata.poBox is UNKNOWN when absent. In contrast the USPS
    // proto3 scalar below omits its false default in normal ProtoJSON output.
    if (
      metadata.poBox !== false ||
      usps.dpvCmra !== "N" ||
      (usps.poBoxOnlyPostalCode !== undefined &&
        usps.poBoxOnlyPostalCode !== false) ||
      usps.addressRecordType !== "H" ||
      (usps.pmbNumber !== undefined && usps.pmbNumber !== "") ||
      (usps.pmbDesignator !== undefined && usps.pmbDesignator !== "")
    )
      return result("UNKNOWN");
    // Intentionally narrow fixture table: unknown codes/names never infer outside.
    const counties: Record<string, string> = {
      "035": "CUYAHOGA",
      "093": "LORAIN",
      "103": "MEDINA",
      "153": "SUMMIT",
    };
    const code = usps.fipsCountyCode;
    const county = usps.county;
    if (
      typeof code !== "string" ||
      !Object.prototype.hasOwnProperty.call(counties, code) ||
      typeof county !== "string" ||
      county.trim().toUpperCase() !== counties[code]
    )
      return result("UNKNOWN");
    return result(code === "035" ? "IN_AREA" : "OUT_OF_AREA");
  } catch {
    return result("UNKNOWN");
  }
}
