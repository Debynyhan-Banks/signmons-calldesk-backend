/** Inactive, fixture-only proof eligibility. Never booking or delivery authority. */
export const VERIFICATION_PROOF_MS = 30 * 60 * 1000;
export type VerificationFreshnessPolicy = {
  mode: "FIXTURE_ONLY";
  version: string;
  noticeVersion: string;
  sourceVersion: string;
  businessPolicyVersion: string;
  lifetimeMs: typeof VERIFICATION_PROOF_MS;
};
export type VerificationProofScope = {
  tenantId: string;
  sessionId: string;
  revision: string;
  expiresAt: number;
};
export type VerificationProof = {
  scope: VerificationProofScope;
  policy: VerificationFreshnessPolicy;
  checkedAt: number;
  confirmedAt: number;
  expiresAt: number;
};
export function validFreshnessPolicy(
  policy: VerificationFreshnessPolicy | null | undefined,
): policy is VerificationFreshnessPolicy {
  return (
    !!policy &&
    policy.mode === "FIXTURE_ONLY" &&
    policy.lifetimeMs === VERIFICATION_PROOF_MS &&
    [
      policy.version,
      policy.noticeVersion,
      policy.sourceVersion,
      policy.businessPolicyVersion,
    ].every((v) => typeof v === "string" && v.length > 0 && v.length <= 200)
  );
}
export function sameFreshnessPolicy(
  a: VerificationFreshnessPolicy | null | undefined,
  b: VerificationFreshnessPolicy | null | undefined,
) {
  return (
    validFreshnessPolicy(a) &&
    validFreshnessPolicy(b) &&
    a.version === b.version &&
    a.noticeVersion === b.noticeVersion &&
    a.sourceVersion === b.sourceVersion &&
    a.businessPolicyVersion === b.businessPolicyVersion
  );
}
export function createVerificationProof(
  scope: VerificationProofScope,
  policy: VerificationFreshnessPolicy | null | undefined,
  checkedAt: number,
  confirmedAt: number,
  sourceExpiresAt = scope.expiresAt,
): VerificationProof | null {
  if (
    !validFreshnessPolicy(policy) ||
    !scope.tenantId ||
    !scope.sessionId ||
    !scope.revision ||
    ![scope.expiresAt, checkedAt, confirmedAt, sourceExpiresAt].every(
      Number.isSafeInteger,
    ) ||
    checkedAt < 0 ||
    confirmedAt < checkedAt
  )
    return null;
  const expiresAt = Math.min(
    scope.expiresAt,
    sourceExpiresAt,
    checkedAt + policy.lifetimeMs,
  );
  if (confirmedAt >= expiresAt) return null;
  return {
    scope: { ...scope },
    policy: { ...policy },
    checkedAt,
    confirmedAt,
    expiresAt,
  };
}
export function verificationProofCurrent(
  proof: VerificationProof | null | undefined,
  scope: VerificationProofScope,
  policy: VerificationFreshnessPolicy | null | undefined,
  now: number,
) {
  if (
    !proof ||
    !proof.scope ||
    !Number.isSafeInteger(now) ||
    !sameFreshnessPolicy(proof.policy, policy)
  )
    return false;
  const valid = createVerificationProof(
    proof.scope,
    proof.policy,
    proof.checkedAt,
    proof.confirmedAt,
    proof.expiresAt,
  );
  return (
    !!valid &&
    valid.expiresAt === proof.expiresAt &&
    now >= proof.confirmedAt &&
    now < proof.expiresAt &&
    proof.scope.tenantId === scope.tenantId &&
    proof.scope.sessionId === scope.sessionId &&
    proof.scope.revision === scope.revision &&
    proof.scope.expiresAt === scope.expiresAt
  );
}
