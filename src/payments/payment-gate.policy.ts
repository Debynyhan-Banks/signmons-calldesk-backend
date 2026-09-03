export type PaymentGateState = "NOT_REQUIRED" | "LOCKED" | "UNLOCKED";

export type PaymentGateReasonCode =
  | "PAYMENT_NOT_REQUIRED"
  | "PAYMENT_REQUIRED_NOT_REQUESTED"
  | "PAYMENT_PENDING"
  | "PAYMENT_FAILED"
  | "PAYMENT_CANCELED"
  | "PAYMENT_REFUNDED"
  | "PAYMENT_SUCCEEDED";

type PaymentGatePayment = {
  status: string;
  amountTotalCents?: number | null;
  currency?: string | null;
} | null;

export type PaymentGateDecision = {
  required: boolean;
  state: PaymentGateState;
  paymentStatus:
    | "NOT_REQUESTED"
    | "PENDING"
    | "SUCCEEDED"
    | "FAILED"
    | "REFUNDED"
    | "CANCELED";
  amountTotalCents: number | null;
  currency: string | null;
  reasonCode: PaymentGateReasonCode;
  label: string;
};

const PAYMENT_STATES = new Set([
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "REFUNDED",
  "CANCELED",
]);

export function evaluatePaymentGate(
  policySnapshot: unknown,
  payment: PaymentGatePayment,
): PaymentGateDecision {
  const policy = record(policySnapshot);
  const required =
    policy?.depositRequired === true || policy?.serviceFeeRequired === true;
  const paymentStatus = PAYMENT_STATES.has(payment?.status ?? "")
    ? (payment?.status as PaymentGateDecision["paymentStatus"])
    : "NOT_REQUESTED";
  const amountTotalCents =
    typeof payment?.amountTotalCents === "number"
      ? payment.amountTotalCents
      : null;
  const currency =
    typeof payment?.currency === "string" && payment.currency.trim()
      ? payment.currency.toLowerCase()
      : null;

  if (!required) {
    return {
      required,
      state: "NOT_REQUIRED",
      paymentStatus,
      amountTotalCents,
      currency,
      reasonCode: "PAYMENT_NOT_REQUIRED",
      label: "Payment is not required before dispatch",
    };
  }

  if (paymentStatus === "SUCCEEDED") {
    return {
      required,
      state: "UNLOCKED",
      paymentStatus,
      amountTotalCents,
      currency,
      reasonCode: "PAYMENT_SUCCEEDED",
      label: "Required payment received; dispatch is unlocked",
    };
  }

  const reason = lockedReason(paymentStatus);
  return {
    required,
    state: "LOCKED",
    paymentStatus,
    amountTotalCents,
    currency,
    reasonCode: reason.code,
    label: reason.label,
  };
}

function lockedReason(status: PaymentGateDecision["paymentStatus"]): {
  code: PaymentGateReasonCode;
  label: string;
} {
  const reasons: Record<
    Exclude<PaymentGateDecision["paymentStatus"], "SUCCEEDED">,
    { code: PaymentGateReasonCode; label: string }
  > = {
    NOT_REQUESTED: {
      code: "PAYMENT_REQUIRED_NOT_REQUESTED",
      label: "Required payment has not been requested",
    },
    PENDING: {
      code: "PAYMENT_PENDING",
      label: "Required payment is pending",
    },
    FAILED: {
      code: "PAYMENT_FAILED",
      label: "Required payment failed",
    },
    CANCELED: {
      code: "PAYMENT_CANCELED",
      label: "Required payment was cancelled",
    },
    REFUNDED: {
      code: "PAYMENT_REFUNDED",
      label: "Required payment was refunded",
    },
  };
  return reasons[status as Exclude<typeof status, "SUCCEEDED">];
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
