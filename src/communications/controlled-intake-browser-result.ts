import { ServiceUnavailableException } from "@nestjs/common";
import { JobStatus } from "@prisma/client";

/** Browser display projection only. Never returns provider proof or action authority. */
export function controlledIntakeBrowserResult(
  value: unknown,
  requestId: string,
) {
  const refuse = (): never => {
    throw new ServiceUnavailableException("Intake outcome unavailable.");
  };
  const record = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : refuse();
  const v = record(value);
  const denied = {
    paymentAuthorized: false as const,
    bookingAuthorized: false as const,
    dispatchAuthorized: false as const,
    deliveryAuthorized: false as const,
  };
  for (const key of Object.keys(denied))
    if (v[key] !== undefined && v[key] !== false) refuse();
  if (
    v.correctionContinuation !== undefined &&
    v.status !== "CORRECTION_REQUIRED"
  )
    refuse();
  if (v.requestId !== undefined && v.requestId !== requestId) refuse();
  if (v.status === "ADMITTED") {
    if (
      v.requestId !== requestId ||
      v.jobCreated !== true ||
      typeof v.jobId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        v.jobId,
      ) ||
      !Object.values(JobStatus).includes(v.state as JobStatus) ||
      Object.keys(denied).some((key) => v[key] !== false)
    )
      refuse();
    return {
      status: "ADMITTED" as const,
      requestId,
      jobId: v.jobId,
      state: v.state as JobStatus,
      jobCreated: true as const,
      ...denied,
    };
  }
  if (v.jobCreated !== false) refuse();
  if (v.reason !== undefined) {
    const safeReasons = [
      "VERIFICATION_LIMIT_REACHED",
      "ADDRESS_REVIEW_UNAVAILABLE",
      "SERVICE_AREA_NOT_CONFIRMED",
      "OUTSIDE_SERVICE_AREA",
      "ADDRESS_CORRECTION_STATE_UNAVAILABLE",
    ] as const;
    if (
      v.status !== "REFUSED" ||
      !safeReasons.includes(v.reason as (typeof safeReasons)[number])
    )
      refuse();
    return {
      status: "REFUSED" as const,
      reason: v.reason as (typeof safeReasons)[number],
      requestId,
      jobCreated: false as const,
      ...denied,
    };
  }
  if (v.status === "REFUSED" || v.status === "UNCERTAIN")
    return {
      status: v.status,
      requestId,
      jobCreated: false as const,
      ...denied,
    };
  if (v.status !== "CORRECTION_REQUIRED") return refuse();
  const c = record(v.candidate);
  const text = (s: unknown, max: number): s is string =>
    typeof s === "string" &&
    s.length > 0 &&
    s.length <= max &&
    s.trim() === s &&
    !/[\p{Cc}\p{Cf}]/u.test(s);
  if (
    !Array.isArray(c.addressLines) ||
    c.addressLines.length < 1 ||
    c.addressLines.length > 3 ||
    !c.addressLines.every((s) => text(s, 200)) ||
    !text(c.city, 60) ||
    typeof c.postalCode !== "string" ||
    !/^\d{5}(-\d{4})?$/.test(c.postalCode) ||
    c.country !== "US" ||
    c.state !== "OH" ||
    typeof v.correctionContinuation !== "string" ||
    v.correctionContinuation.length < 40 ||
    v.correctionContinuation.length > 4096 ||
    !v.correctionContinuation.startsWith("v1.") ||
    !/^[A-Za-z0-9._-]+$/.test(v.correctionContinuation)
  )
    return refuse();
  return {
    status: "CORRECTION_REQUIRED" as const,
    requestId,
    jobCreated: false as const,
    ...denied,
    correctionContinuation: v.correctionContinuation,
    candidate: {
      addressLines: [...c.addressLines] as string[],
      city: c.city,
      postalCode: c.postalCode,
      country: "US" as const,
      state: "OH" as const,
    },
  };
}
