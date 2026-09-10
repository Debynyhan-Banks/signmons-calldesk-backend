import { BadRequestException, ConflictException } from "@nestjs/common";
import { exact, object, timestamp } from "./organization-profile";
export { exact, object, timestamp };
export const ORGANIZATION_PAYMENT_POLICY = "organizationPaymentPolicyV1";
export type PaymentPolicyDraft = {
  currency: "usd";
  serviceFeeRequired: boolean;
  serviceFeeCents: number | null;
  depositRequired: boolean;
  depositPolicy: { kind: "none" } | { kind: "fixed"; amountCents: number };
  emergencyFeePolicy: { kind: "none" };
  paymentGateMode: "fail_closed";
  webhookValidationRequired: true;
};
export type OrganizationPaymentPolicy = {
  version: 1;
  draft: PaymentPolicyDraft;
  approved: null | {
    draft: PaymentPolicyDraft;
    actorId: string;
    approvedAt: string;
  };
};
const money = (value: unknown) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= 100000000;
export function draft(value: unknown): PaymentPolicyDraft {
  const row = object(value);
  if (
    !row ||
    !exact(row, [
      "currency",
      "serviceFeeRequired",
      "serviceFeeCents",
      "depositRequired",
      "depositPolicy",
      "emergencyFeePolicy",
      "paymentGateMode",
      "webhookValidationRequired",
    ]) ||
    row.currency !== "usd" ||
    typeof row.serviceFeeRequired !== "boolean" ||
    typeof row.depositRequired !== "boolean" ||
    row.paymentGateMode !== "fail_closed" ||
    row.webhookValidationRequired !== true ||
    !exact(row.emergencyFeePolicy, ["kind"]) ||
    object(row.emergencyFeePolicy)?.kind !== "none"
  )
    throw new BadRequestException(
      "Only explicit fixed USD fail-closed policies are supported.",
    );
  if (
    row.serviceFeeRequired
      ? !money(row.serviceFeeCents)
      : row.serviceFeeCents !== null
  )
    throw new BadRequestException(
      "Service fee must be positive integer cents when required, otherwise null.",
    );
  const deposit = object(row.depositPolicy);
  if (
    row.depositRequired
      ? !exact(deposit, ["kind", "amountCents"]) ||
        deposit?.kind !== "fixed" ||
        !money(deposit.amountCents)
      : !exact(deposit, ["kind"]) || deposit?.kind !== "none"
  )
    throw new BadRequestException("Choose a fixed positive deposit or none.");
  return {
    currency: "usd",
    serviceFeeRequired: row.serviceFeeRequired,
    serviceFeeCents: row.serviceFeeCents as number | null,
    depositRequired: row.depositRequired,
    depositPolicy: row.depositRequired
      ? { kind: "fixed", amountCents: deposit!.amountCents as number }
      : { kind: "none" },
    emergencyFeePolicy: { kind: "none" },
    paymentGateMode: "fail_closed",
    webhookValidationRequired: true,
  };
}
export function profile(value: unknown): OrganizationPaymentPolicy | null {
  if (value === undefined) return null;
  try {
    if (!exact(value, ["version", "draft", "approved"])) throw Error();
    const row = object(value)!;
    if (row.version !== 1) throw Error();
    let approved: OrganizationPaymentPolicy["approved"] = null;
    if (row.approved !== null) {
      if (!exact(row.approved, ["draft", "actorId", "approvedAt"]))
        throw Error();
      const a = object(row.approved)!;
      if (
        typeof a.actorId !== "string" ||
        !a.actorId.trim() ||
        !timestamp(a.approvedAt)
      )
        throw Error();
      approved = {
        draft: draft(a.draft),
        actorId: a.actorId,
        approvedAt: a.approvedAt,
      };
    }
    return { version: 1, draft: draft(row.draft), approved };
  } catch {
    throw new ConflictException(
      "Stored payment policy requires administrator review.",
    );
  }
}
