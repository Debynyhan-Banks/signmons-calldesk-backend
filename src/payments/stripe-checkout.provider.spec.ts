import { ServiceUnavailableException } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import appConfig from "../config/app.config";
import { StripeCheckoutProvider } from "./stripe-checkout.provider";

const activeExpiresAt = Math.floor(Date.now() / 1000) + 60 * 60;

describe("StripeCheckoutProvider", () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "cs_test_private",
          payment_intent: "pi_test_private",
          url: "https://checkout.stripe.com/session",
          expires_at: activeExpiresAt,
          status: "open",
          payment_status: "unpaid",
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
      checkoutUrl: "https://checkout.stripe.com/session",
      expiresAt: new Date(activeExpiresAt * 1000),
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

  it("recovers an existing open Checkout from the same connected account", async () => {
    const provider = new StripeCheckoutProvider(config({}));

    const result = await provider.recoverCheckout({
      connectedAccountId: "acct_connected",
      sessionId: "cs_test_private",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/checkout/sessions/cs_test_private",
      {
        method: "GET",
        headers: {
          Authorization: "Bearer sk_test_not_real",
          "Stripe-Account": "acct_connected",
        },
        signal: expect.any(AbortSignal),
      },
    );
    expect(result).toEqual({
      checkoutUrl: "https://checkout.stripe.com/session",
      expiresAt: new Date(activeExpiresAt * 1000),
    });
  });

  it("does not recover a completed Checkout", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "cs_test_private",
          status: "complete",
          payment_status: "paid",
          url: null,
          expires_at: Math.floor(Date.now() / 1000) + 600,
        }),
        { status: 200 },
      ),
    );
    const provider = new StripeCheckoutProvider(config({}));

    await expect(
      provider.recoverCheckout({
        connectedAccountId: "acct_connected",
        sessionId: "cs_test_private",
      }),
    ).resolves.toBeNull();
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
