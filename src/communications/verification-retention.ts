export const RESOLVED_REFERENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export type VerificationLifecycle = {
  version: 1;
  expiresAt: number;
  closedAt: number | null;
  purgedAt: number | null;
};
export function lifecycle(value: unknown): VerificationLifecycle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as VerificationLifecycle;
  if (
    Object.keys(v).sort().join(",") !== "closedAt,expiresAt,purgedAt,version" ||
    v.version !== 1 ||
    !Number.isSafeInteger(v.expiresAt) ||
    v.expiresAt <= 0 ||
    ![v.closedAt, v.purgedAt].every(
      (t) => t === null || (Number.isSafeInteger(t) && t >= 0),
    )
  )
    return null;
  if (v.purgedAt !== null && v.closedAt === null) return null;
  return { ...v };
}
export function sessionCleanupDue(v: VerificationLifecycle, now: number) {
  return (
    Number.isSafeInteger(now) &&
    now >= 0 &&
    (v.closedAt !== null || now >= v.expiresAt)
  );
}
export function resolvedReferenceDue(
  state: string,
  held: bigint,
  attemptId: string | null,
  resolvedAt: number,
  now: number,
) {
  return (
    state === "CANCELLED" &&
    held === 0n &&
    attemptId === null &&
    Number.isSafeInteger(resolvedAt) &&
    resolvedAt >= 0 &&
    Number.isSafeInteger(now) &&
    now >= resolvedAt + RESOLVED_REFERENCE_RETENTION_MS
  );
}
