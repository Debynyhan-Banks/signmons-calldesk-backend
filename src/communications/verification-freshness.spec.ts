import {
  createVerificationProof,
  verificationProofCurrent,
  VERIFICATION_PROOF_MS,
  type VerificationFreshnessPolicy,
} from "./verification-freshness";

describe("1A fixture verification freshness", () => {
  const policy: VerificationFreshnessPolicy = {
    mode: "FIXTURE_ONLY",
    version: "v1",
    lifetimeMs: VERIFICATION_PROOF_MS,
    noticeVersion: "notice",
    sourceVersion: "source",
    businessPolicyVersion: "business",
  };
  const scope = {
    tenantId: "tenant",
    sessionId: "session",
    revision: "phone-or-address-v1",
    expiresAt: 7200000,
  };
  it("expires exactly thirty minutes from check, not confirmation or reuse", () => {
    const proof = createVerificationProof(scope, policy, 1000, 2000)!;
    expect(proof.expiresAt).toBe(1801000);
    expect(verificationProofCurrent(proof, scope, policy, 1800999)).toBe(true);
    expect(verificationProofCurrent(proof, scope, policy, 1801000)).toBe(false);
    expect(proof.checkedAt).toBe(1000);
  });
  it("caps proof at session and earlier authoritative expiry", () => {
    expect(
      createVerificationProof({ ...scope, expiresAt: 5000 }, policy, 1000, 2000)
        ?.expiresAt,
    ).toBe(5000);
    expect(
      createVerificationProof(scope, policy, 1000, 2000, 3000)?.expiresAt,
    ).toBe(3000);
    expect(createVerificationProof(scope, policy, 1000, 3000, 3000)).toBeNull();
  });
  it.each(["tenantId", "sessionId", "revision", "expiresAt"] as const)(
    "refuses changed %s",
    (key) => {
      const proof = createVerificationProof(scope, policy, 1000, 1000);
      expect(
        verificationProofCurrent(
          proof,
          { ...scope, [key]: key === "expiresAt" ? 7200001 : "changed" },
          policy,
          2000,
        ),
      ).toBe(false);
    },
  );
  it.each([
    "version",
    "noticeVersion",
    "sourceVersion",
    "businessPolicyVersion",
  ] as const)("refuses changed %s policy", (key) => {
    const proof = createVerificationProof(scope, policy, 1000, 1000);
    expect(
      verificationProofCurrent(
        proof,
        scope,
        { ...policy, [key]: "changed" },
        2000,
      ),
    ).toBe(false);
  });
  it("refuses missing policy, invalid time, future proof and excessive lifetime", () => {
    expect(createVerificationProof(scope, null, 1000, 1000)).toBeNull();
    expect(
      createVerificationProof(
        scope,
        { ...policy, lifetimeMs: 86400000 },
        1000,
        1000,
      ),
    ).toBeNull();
    const proof = createVerificationProof(scope, policy, 1000, 1000);
    for (const now of [999, NaN, Infinity, 1000.5])
      expect(verificationProofCurrent(proof, scope, policy, now)).toBe(false);
    expect(verificationProofCurrent(proof, scope, null, 2000)).toBe(false);
  });
  it("copies immutable binding and refuses tampered deadlines", () => {
    const p = { ...policy },
      s = { ...scope };
    const proof = createVerificationProof(s, p, 1000, 1000)!;
    p.version = "changed";
    s.revision = "changed";
    expect(verificationProofCurrent(proof, scope, policy, 2000)).toBe(true);
    expect(
      verificationProofCurrent(
        { ...proof, expiresAt: 7200000 },
        scope,
        policy,
        2000,
      ),
    ).toBe(false);
  });
});
