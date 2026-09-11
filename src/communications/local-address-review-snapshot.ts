import { ConflictException } from "@nestjs/common";

/** Historical fictional evidence only; never a verification or admission capability. */
export function localAddressReviewSnapshot(value: unknown) {
  const v = value as Record<string, unknown>;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(",") !==
      "address,addressAuthorized,bookingAuthorized,candidateId,coverage,deliveryAuthorized,fixtureOnly,query,revision,unit" ||
    v.fixtureOnly !== true ||
    v.addressAuthorized !== false ||
    v.bookingAuthorized !== false ||
    v.deliveryAuthorized !== false ||
    !Number.isSafeInteger(v.revision) ||
    Number(v.revision) < 1 ||
    Number(v.revision) > 20 ||
    typeof v.candidateId !== "string" ||
    !/^[a-z0-9-]{1,40}$/.test(v.candidateId) ||
    typeof v.query !== "string" ||
    !v.query ||
    v.query.length > 200 ||
    typeof v.unit !== "string" ||
    v.unit.length > 40 ||
    typeof v.address !== "string" ||
    !v.address ||
    v.address.length > 200 ||
    [v.query, v.unit, v.address].some(
      (s) =>
        typeof s === "string" && (s.trim() !== s || /[\p{Cc}\p{Cf}]/u.test(s)),
    ) ||
    !["FIXTURE_IN_AREA", "OUT_OF_AREA", "UNKNOWN"].includes(String(v.coverage))
  )
    throw new ConflictException();
  return {
    fixtureOnly: true as const,
    revision: v.revision as number,
    candidateId: v.candidateId,
    query: v.query,
    unit: v.unit,
    address: v.address,
    coverage: v.coverage as string,
    addressAuthorized: false as const,
    bookingAuthorized: false as const,
    deliveryAuthorized: false as const,
  };
}
