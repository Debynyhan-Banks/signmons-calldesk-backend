import { evaluatePaymentGate } from "./payment-gate.policy";

describe("evaluatePaymentGate", () => {
  it("leaves dispatch open when neither a deposit nor service fee is required", () => {
    expect(evaluatePaymentGate({}, null)).toEqual({
      required: false,
      state: "NOT_REQUIRED",
      paymentStatus: "NOT_REQUESTED",
      amountTotalCents: null,
      currency: null,
      reasonCode: "PAYMENT_NOT_REQUIRED",
      label: "Payment is not required before dispatch",
    });
  });

  it.each(["depositRequired", "serviceFeeRequired"])(
    "locks dispatch when %s is true and payment was not requested",
    (policyKey) => {
      expect(evaluatePaymentGate({ [policyKey]: true }, null)).toMatchObject({
        required: true,
        state: "LOCKED",
        paymentStatus: "NOT_REQUESTED",
        reasonCode: "PAYMENT_REQUIRED_NOT_REQUESTED",
      });
    },
  );

  it("unlocks only after successful payment and returns no provider identifiers", () => {
    const result = evaluatePaymentGate(
      { depositRequired: true },
      {
        status: "SUCCEEDED",
        amountTotalCents: 9900,
        currency: "USD",
      },
    );

    expect(result).toEqual({
      required: true,
      state: "UNLOCKED",
      paymentStatus: "SUCCEEDED",
      amountTotalCents: 9900,
      currency: "usd",
      reasonCode: "PAYMENT_SUCCEEDED",
      label: "Required payment received; dispatch is unlocked",
    });
    expect(result).not.toHaveProperty("stripePaymentIntentId");
    expect(result).not.toHaveProperty("stripeCheckoutSessionId");
  });

  it.each([
    ["PENDING", "PAYMENT_PENDING"],
    ["FAILED", "PAYMENT_FAILED"],
    ["CANCELED", "PAYMENT_CANCELED"],
    ["REFUNDED", "PAYMENT_REFUNDED"],
  ])("keeps %s payments locked", (status, reasonCode) => {
    expect(
      evaluatePaymentGate({ depositRequired: true }, { status }),
    ).toMatchObject({ state: "LOCKED", paymentStatus: status, reasonCode });
  });
});
