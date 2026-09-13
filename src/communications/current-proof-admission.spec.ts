import { Prisma } from "@prisma/client";
import {
  AdmissionSourceEvidence,
  consumeCurrentAdmissionProof,
} from "./current-proof-admission";
import {
  createVerificationProof,
  VerificationFreshnessPolicy,
} from "./verification-freshness";

describe("inactive current-proof admission boundary", () => {
  const now = 1000000,
    approvedAt = new Date(now - 100).toISOString();
  const input = {
    tenantId: "tenant",
    sessionId: "session",
    conversationId: "conversation",
    requestId: "request",
    expiresAt: now + 10000,
    phone: "+12025550196",
    address: "Fictional",
    organizationApprovedAt: approvedAt,
  };
  const policy: VerificationFreshnessPolicy = {
    mode: "FIXTURE_ONLY",
    version: "v1",
    lifetimeMs: 1800000,
    noticeVersion: "n1",
    sourceVersion: "s1",
    businessPolicyVersion: approvedAt,
  };
  const payment = {
    currency: "usd" as const,
    serviceFeeRequired: true,
    serviceFeeCents: 100,
    depositRequired: false,
    depositPolicy: { kind: "none" as const },
    emergencyFeePolicy: { kind: "none" as const },
    paymentGateMode: "fail_closed" as const,
    webhookValidationRequired: true as const,
  };
  const proof = (revision: string) =>
    createVerificationProof(
      { ...input, revision },
      policy,
      now - 10,
      now - 10,
    )!;
  const evidence = (): AdmissionSourceEvidence => ({
    mode: "FIXTURE_ONLY",
    phone: {
      reference: "phone-ref",
      value: input.phone,
      revision: "p1",
      usEligible: true,
      state: "APPROVED",
      proof: proof("p1"),
    },
    address: {
      reference: "address-ref",
      value: input.address,
      revision: "a1",
      confirmed: true,
      state: "VALIDATED",
      proof: proof("a1"),
    },
    coverage: {
      reference: "county-ref",
      policyVersion: "c1",
      country: "US",
      state: "OH",
      county: "39035",
      outcome: "IN_AREA",
      addressRevision: "a1",
      proof: proof("a1"),
    },
    current: {
      phoneRevision: "p1",
      addressRevision: "a1",
      coveragePolicyVersion: "c1",
      freshness: { ...policy },
      paymentApprovedAt: approvedAt,
      payment,
    },
  });
  const tx = {
    $queryRaw: jest.fn(() => Promise.resolve([{ ms: BigInt(now) }])),
    tenantOrganization: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          settings: {
            organizationPaymentPolicyV1: {
              version: 1,
              draft: payment,
              approved: { draft: payment, actorId: "owner", approvedAt },
            },
          },
        }),
      ),
    },
  };
  const run = (e: AdmissionSourceEvidence | null) =>
    consumeCurrentAdmissionProof(
      tx as unknown as Prisma.TransactionClient,
      { mode: "FIXTURE_ONLY", resolve: () => Promise.resolve(e) },
      input,
    );
  it("returns only minimal references and explicit non-authority", async () => {
    const result = await run(evidence());
    expect(result.fixtureOnly).toBe(true);
    expect(result.realVerificationAccepted).toBe(false);
    expect(result.deliveryAuthorized).toBe(false);
    expect(JSON.stringify(result)).not.toContain(input.phone);
    expect(JSON.stringify(result)).not.toContain(input.address);
  });
  it.each<[string, (e: AdmissionSourceEvidence) => void]>([
    [
      "wrong phone",
      (e) => {
        e.phone.value = "other";
      },
    ],
    [
      "wrong address",
      (e) => {
        e.address.value = "other";
      },
    ],
    [
      "uncertain phone",
      (e) => {
        e.phone.state = "UNCERTAIN";
      },
    ],
    [
      "non-US phone",
      (e) => {
        e.phone.usEligible = false;
      },
    ],
    [
      "unconfirmed correction",
      (e) => {
        e.address.confirmed = false;
      },
    ],
    [
      "unknown county",
      (e) => {
        e.coverage.outcome = "UNKNOWN";
      },
    ],
    [
      "adjacent county",
      (e) => {
        e.coverage.county = "39093";
      },
    ],
    [
      "wrong state",
      (e) => {
        e.coverage.state = "PA";
      },
    ],
    [
      "changed phone revision",
      (e) => {
        e.current.phoneRevision = "p2";
      },
    ],
    [
      "changed address revision",
      (e) => {
        e.current.addressRevision = "a2";
      },
    ],
    [
      "changed coverage policy",
      (e) => {
        e.current.coveragePolicyVersion = "c2";
      },
    ],
    [
      "changed organization",
      (e) => {
        e.current.freshness.businessPolicyVersion = "changed";
      },
    ],
    [
      "changed payment",
      (e) => {
        e.current.paymentApprovedAt = new Date(now - 200).toISOString();
      },
    ],
    [
      "foreign session",
      (e) => {
        e.phone.proof.scope.sessionId = "other";
      },
    ],
    [
      "expired proof",
      (e) => {
        e.phone.proof.expiresAt = now;
      },
    ],
    [
      "future proof",
      (e) => {
        e.phone.proof.confirmedAt = now + 1;
      },
    ],
  ])("refuses %s", async (_name, mutate) => {
    const e = evidence();
    mutate(e);
    await expect(run(e)).rejects.toThrow();
  });
  it("refuses missing source evidence", async () => {
    await expect(run(null)).rejects.toThrow();
  });
});
