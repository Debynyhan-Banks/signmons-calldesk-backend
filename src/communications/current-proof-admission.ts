import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CustomerSessionScope } from "./customer-consent-session-lock";
import {
  VerificationProof,
  VerificationFreshnessPolicy,
  verificationProofCurrent,
} from "./verification-freshness";
import {
  PaymentPolicyDraft,
  draft as paymentDraft,
  profile as paymentProfile,
  object,
  ORGANIZATION_PAYMENT_POLICY,
} from "../tenants/organization-payment-policy";

export type AdmissionProofInput = CustomerSessionScope & {
  requestId: string;
  expiresAt: number;
  phone: string;
  address: string;
  organizationApprovedAt: string;
};
export type AdmissionSourceEvidence = {
  mode: "FIXTURE_ONLY";
  phone: {
    reference: string;
    value: string;
    revision: string;
    usEligible: boolean;
    state: string;
    proof: VerificationProof;
  };
  address: {
    reference: string;
    value: string;
    revision: string;
    confirmed: boolean;
    state: string;
    proof: VerificationProof;
  };
  coverage: {
    reference: string;
    policyVersion: string;
    country: string;
    state: string;
    county: string;
    outcome: string;
    addressRevision: string;
    proof: VerificationProof;
  };
  current: {
    phoneRevision: string;
    addressRevision: string;
    coveragePolicyVersion: string;
    freshness: VerificationFreshnessPolicy;
    paymentApprovedAt: string;
    payment: PaymentPolicyDraft;
  };
};
/** Trusted local composition only. Resolve under the caller's transaction/locks.
 * Never a browser payload or network/provider call. No production registration.
 */
export interface CurrentProofSource {
  mode: "FIXTURE_ONLY";
  resolve(
    tx: Prisma.TransactionClient,
    input: Readonly<AdmissionProofInput>,
  ): Promise<AdmissionSourceEvidence | null>;
}
export async function consumeCurrentAdmissionProof(
  tx: Prisma.TransactionClient,
  source: CurrentProofSource,
  input: AdmissionProofInput,
) {
  if (source.mode !== "FIXTURE_ONLY") throw new ConflictException();
  const e = await source.resolve(tx, Object.freeze({ ...input }));
  const [clock] = await tx.$queryRaw<{ ms: bigint }[]>(
    Prisma.sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms`,
  );
  const now = Number(clock?.ms);
  const tenant = await tx.tenantOrganization.findUnique({
    where: { id: input.tenantId },
    select: { settings: true },
  });
  const approvedPayment = paymentProfile(
    object(tenant?.settings)?.[ORGANIZATION_PAYMENT_POLICY],
  )?.approved;
  const ref = (v: unknown) =>
    typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
  if (
    !approvedPayment ||
    !e ||
    e.mode !== "FIXTURE_ONLY" ||
    !e.phone ||
    !e.address ||
    !e.coverage ||
    !e.current ||
    ![
      e.phone.reference,
      e.address.reference,
      e.coverage.reference,
      e.coverage.policyVersion,
    ].every(ref) ||
    e.phone.value !== input.phone ||
    e.address.value !== input.address ||
    e.phone.state !== "APPROVED" ||
    e.phone.usEligible !== true ||
    e.address.state !== "VALIDATED" ||
    e.address.confirmed !== true ||
    e.coverage.country !== "US" ||
    e.coverage.state !== "OH" ||
    e.coverage.county !== "39035" ||
    e.coverage.outcome !== "IN_AREA" ||
    e.coverage.addressRevision !== e.address.revision ||
    e.coverage.policyVersion !== e.current.coveragePolicyVersion ||
    e.current.freshness?.businessPolicyVersion !==
      input.organizationApprovedAt ||
    !Number.isFinite(Date.parse(e.current.paymentApprovedAt)) ||
    Date.parse(e.current.paymentApprovedAt) > now ||
    !verificationProofCurrent(
      e.phone.proof,
      {
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        revision: e.current.phoneRevision,
        expiresAt: input.expiresAt,
      },
      e.current.freshness,
      now,
    ) ||
    !verificationProofCurrent(
      e.address.proof,
      {
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        revision: e.current.addressRevision,
        expiresAt: input.expiresAt,
      },
      e.current.freshness,
      now,
    ) ||
    e.phone.revision !== e.current.phoneRevision ||
    e.address.revision !== e.current.addressRevision
  )
    throw new ConflictException(
      "Current verification and approved policies required; no job created.",
    );
  const payment = paymentDraft(e.current.payment);
  if (
    !verificationProofCurrent(
      e.coverage.proof,
      {
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        revision: e.current.addressRevision,
        expiresAt: input.expiresAt,
      },
      e.current.freshness,
      now,
    )
  )
    throw new ConflictException("Current county evidence required.");
  if (
    approvedPayment.approvedAt !== e.current.paymentApprovedAt ||
    JSON.stringify(approvedPayment.draft) !== JSON.stringify(payment)
  )
    throw new ConflictException(
      "Approved payment policy changed; review again.",
    );
  return {
    version: 1 as const,
    fixtureOnly: true as const,
    phoneReference: e.phone.reference,
    addressReference: e.address.reference,
    coverageReference: e.coverage.reference,
    coveragePolicyVersion: e.coverage.policyVersion,
    county: "39035",
    consumedAt: now,
    expiresAt: Math.min(
      e.phone.proof.expiresAt,
      e.address.proof.expiresAt,
      e.coverage.proof.expiresAt,
    ),
    organizationApprovedAt: input.organizationApprovedAt,
    paymentApprovedAt: e.current.paymentApprovedAt,
    payment,
    realVerificationAccepted: false as const,
    bookingAuthorized: false as const,
    deliveryAuthorized: false as const,
  };
}
