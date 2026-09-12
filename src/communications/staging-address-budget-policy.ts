import { createHash } from "node:crypto";

type Limit = { micros: number; requests: number };
export type StagingAddressBudgetPacket = {
  mode: "STAGING_REVIEW_ONLY";
  version: string;
  approvalId: string;
  accountId: string;
  projectId: string;
  serviceId: string;
  runtimeIdentity: string;
  tenantId: string;
  sessionId: string;
  currency: "USD";
  rateVersion: string;
  costMicros: number;
  validFrom: number;
  validUntil: number;
  account: Limit;
  tenant: Limit;
  session: Limit;
};

export type StagingAddressBudgetAuthority = {
  // Trusted current server/approval-registry values, never request-body fields.
  environment: "staging";
  accountId: string;
  projectId: string;
  serviceId: string;
  runtimeIdentity: string;
  tenantId: string;
  sessionId: string;
  approvalId: string;
  packetDigest: string;
  rateVersion: string;
  costMicros: number;
  rateValidUntil: number;
  sessionExpiresAt: number;
  enabled: boolean;
  now: number;
  // Include consumed AND unresolved held amounts across periods. No free-tier
  // credit, monthly reset, or unacknowledged refund may reduce these totals.
  usage: { account: Limit; tenant: Limit; session: Limit };
};

const scopes = ["account", "tenant", "session"] as const;
const identities = [
  "accountId",
  "projectId",
  "serviceId",
  "runtimeIdentity",
  "tenantId",
  "sessionId",
  "approvalId",
  "rateVersion",
] as const;
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9@_.:-]{1,160}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function limit(value: unknown): value is Limit {
  return (
    record(value) &&
    Object.keys(value).sort().join() === "micros,requests" &&
    integer(value.micros) &&
    integer(value.requests)
  );
}
function packet(value: unknown): value is StagingAddressBudgetPacket {
  return (
    record(value) &&
    Object.keys(value).sort().join() ===
      "account,accountId,approvalId,costMicros,currency,mode,projectId,rateVersion,runtimeIdentity,serviceId,session,sessionId,tenant,tenantId,validFrom,validUntil,version" &&
    value.mode === "STAGING_REVIEW_ONLY" &&
    value.currency === "USD" &&
    text(value.version) &&
    identities.every((key) => text(value[key])) &&
    integer(value.costMicros) &&
    value.costMicros > 0 &&
    integer(value.validFrom) &&
    integer(value.validUntil) &&
    value.validUntil > value.validFrom &&
    scopes.every((key) => limit(value[key]))
  );
}

/** Canonical reviewed packet identity. It is not a signature or approval; only a
 * trusted registry may supply the independently approved digest to the gate.
 */
export function stagingAddressPacketDigest(
  value: StagingAddressBudgetPacket,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.mode,
        value.version,
        ...identities.map((key) => value[key]),
        value.currency,
        value.costMicros,
        value.validFrom,
        value.validUntil,
        ...scopes.flatMap((key) => [value[key].micros, value[key].requests]),
      ]),
    )
    .digest("hex");
}

/** Inactive pre-reservation policy check. No registration, provider, defaults or
 * writes. Passing is NOT a reservation or permission to dispatch. Future live
 * integration must re-read authority and totals under the reservation lock.
 */
export function reviewStagingAddressBudget(
  value: unknown,
  authority?: StagingAddressBudgetAuthority,
) {
  const result = (status: "REFUSED" | "POLICY_READY") => ({
    status,
    dispatchAuthorized: false as const,
    admissionAuthorized: false as const,
    deliveryAuthorized: false as const,
  });
  if (
    !packet(value) ||
    !authority ||
    authority.environment !== "staging" ||
    authority.enabled !== true ||
    !identities.every(
      (key) => text(authority[key]) && value[key] === authority[key],
    ) ||
    authority.packetDigest !== stagingAddressPacketDigest(value) ||
    !integer(authority.now) ||
    !integer(authority.rateValidUntil) ||
    !integer(authority.sessionExpiresAt) ||
    value.validFrom > authority.now ||
    value.validUntil <= authority.now ||
    value.validUntil > authority.rateValidUntil ||
    value.validUntil > authority.sessionExpiresAt ||
    value.costMicros !== authority.costMicros ||
    !record(authority.usage)
  )
    return result("REFUSED");
  for (const scope of scopes) {
    const used = authority.usage[scope];
    const cap = value[scope];
    if (
      !limit(used) ||
      cap.requests < 1 ||
      cap.requests > 10000 ||
      cap.micros < value.costMicros ||
      used.micros > cap.micros - value.costMicros ||
      used.requests >= cap.requests
    )
      return result("REFUSED");
  }
  return result("POLICY_READY");
}
