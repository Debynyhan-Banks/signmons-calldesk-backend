import { ServiceUnavailableException } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import appConfig from "../config/app.config";
import { StripeCheckoutProvider } from "./stripe-checkout.provider";

describe("StripeCheckoutProvider", () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "cs_test_private",
          payment_intent: "pi_test_private",
          url: "https://checkout.stripe.test/session",
          expires_at: 1_788_527_600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it("creates a direct connected-account checkout with no Signmons fee", async () => {
    const provider = new StripeCheckoutProvider(
      config({ stripeSecretKey: "sk_test_not_real" }),
    );

    const result = await provider.createCheckout({
      tenantId: "10000000-0000-4000-8000-000000000001",
      jobId: "20000000-0000-4000-8000-000000000002",
      paymentRequestId: "30000000-0000-4000-8000-000000000003",
      connectedAccountId: "acct_connected",
      idempotencyKey: "40000000-0000-4000-8000-000000000004",
      amountTotalCents: 12500,
      currency: "usd",
      label: "Required service deposit",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/checkout/sessions",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer sk_test_not_real",
          "Content-Type": "application/x-www-form-urlencoded",
          "Stripe-Account": "acct_connected",
          "Idempotency-Key": "40000000-0000-4000-8000-000000000004",
        },
        signal: expect.any(AbortSignal),
      }),
    );
    const options = fetchMock.mock.calls[0]?.[1];
    expect(options?.body).toBeInstanceOf(URLSearchParams);
    const body = options?.body as URLSearchParams;
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("12500");
    expect(body.get("line_items[0][price_data][currency]")).toBe("usd");
    expect(body.get("application_fee_amount")).toBeNull();
    expect(result).toEqual({
      sessionId: "cs_test_private",
      paymentIntentId: "pi_test_private",
      checkoutUrl: "https://checkout.stripe.test/session",
      expiresAt: new Date(1_788_527_600 * 1000),
    });
  });

  it("fails closed without a configured secret", async () => {
    const provider = new StripeCheckoutProvider(
      config({ stripeSecretKey: "" }),
    );

    await expect(
      provider.createCheckout({
        tenantId: "10000000-0000-4000-8000-000000000001",
        jobId: "20000000-0000-4000-8000-000000000002",
        paymentRequestId: "30000000-0000-4000-8000-000000000003",
        connectedAccountId: "acct_connected",
        idempotencyKey: "40000000-0000-4000-8000-000000000004",
        amountTotalCents: 12500,
        currency: "usd",
        label: "Required service deposit",
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sanitizes provider errors", async () => {
    const provider = new StripeCheckoutProvider(config({}));
    fetchMock.mockResolvedValue(
      new Response("sensitive provider error", { status: 400 }),
    );

    await expect(
      provider.createCheckout({
        tenantId: "10000000-0000-4000-8000-000000000001",
        jobId: "20000000-0000-4000-8000-000000000002",
        paymentRequestId: "30000000-0000-4000-8000-000000000003",
        connectedAccountId: "acct_connected",
        idempotencyKey: "40000000-0000-4000-8000-000000000004",
        amountTotalCents: 12500,
        currency: "usd",
        label: "Required service deposit",
      }),
    ).rejects.toThrow("Secure payment checkout is temporarily unavailable.");
  });
});

function config(
  overrides: Partial<ConfigType<typeof appConfig>>,
): ConfigType<typeof appConfig> {
  return {
    stripeSecretKey: "sk_test_not_real",
    customerPaymentReturnUrl: "https://app.example.test/payment/status",
    ...overrides,
  } as ConfigType<typeof appConfig>;
}
