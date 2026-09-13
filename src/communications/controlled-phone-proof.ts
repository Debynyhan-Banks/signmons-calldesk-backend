import {
  VERIFICATION_PROOF_MS,
  VerificationProofScope,
} from "./verification-freshness";

/** Separate from FIXTURE_ONLY. Only the bound durable CHECK writer may issue it. */
export type ControlledPhonePolicy = {
  mode: "CONTROLLED_VERIFY_V1";
  version: string;
  accountSid: string;
  serviceSid: string;
  noticeVersion: string;
  businessPolicyVersion: string;
  lifetimeMs: typeof VERIFICATION_PROOF_MS;
};
export type ControlledPhoneProof = {
  scope: VerificationProofScope;
  policy: ControlledPhonePolicy;
  checkedAt: number;
  expiresAt: number;
};
export function validControlledPhonePolicy(
  p: ControlledPhonePolicy | null | undefined,
): p is ControlledPhonePolicy {
  return (
    !!p &&
    Object.keys(p).sort().join() ===
      "accountSid,businessPolicyVersion,lifetimeMs,mode,noticeVersion,serviceSid,version" &&
    p.mode === "CONTROLLED_VERIFY_V1" &&
    p.lifetimeMs === VERIFICATION_PROOF_MS &&
    /^AC[0-9a-f]{32}$/i.test(p.accountSid) &&
    /^VA[0-9a-f]{32}$/i.test(p.serviceSid) &&
    [p.version, p.noticeVersion, p.businessPolicyVersion].every(
      (v) => typeof v === "string" && v.length > 0 && v.length <= 200,
    )
  );
}
export function sameControlledPhonePolicy(
  a: ControlledPhonePolicy | null | undefined,
  b: ControlledPhonePolicy | null | undefined,
) {
  return (
    validControlledPhonePolicy(a) &&
    validControlledPhonePolicy(b) &&
    a.version === b.version &&
    a.accountSid === b.accountSid &&
    a.serviceSid === b.serviceSid &&
    a.noticeVersion === b.noticeVersion &&
    a.businessPolicyVersion === b.businessPolicyVersion
  );
}
export function createControlledPhoneProof(
  scope: VerificationProofScope,
  policy: ControlledPhonePolicy,
  checkedAt: number,
): ControlledPhoneProof | null {
  if (
    !validControlledPhonePolicy(policy) ||
    !scope.tenantId ||
    !scope.sessionId ||
    !scope.revision ||
    !Number.isSafeInteger(checkedAt) ||
    checkedAt < 0 ||
    !Number.isSafeInteger(scope.expiresAt) ||
    checkedAt >= scope.expiresAt
  )
    return null;
  return {
    scope: { ...scope },
    policy: { ...policy },
    checkedAt,
    expiresAt: Math.min(scope.expiresAt, checkedAt + VERIFICATION_PROOF_MS),
  };
}
export function controlledPhoneProofCurrent(
  proof: ControlledPhoneProof | null | undefined,
  scope: VerificationProofScope,
  policy: ControlledPhonePolicy | null | undefined,
  now: number,
) {
  if (
    !proof?.scope ||
    !sameControlledPhonePolicy(proof.policy, policy) ||
    !Number.isSafeInteger(now)
  )
    return false;
  const expected = createControlledPhoneProof(
    proof.scope,
    proof.policy,
    proof.checkedAt,
  );
  return (
    !!expected &&
    expected.expiresAt === proof.expiresAt &&
    now >= proof.checkedAt &&
    now < proof.expiresAt &&
    proof.scope.tenantId === scope.tenantId &&
    proof.scope.sessionId === scope.sessionId &&
    proof.scope.revision === scope.revision &&
    proof.scope.expiresAt === scope.expiresAt
  );
}
