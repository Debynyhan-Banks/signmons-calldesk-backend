import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import appConfig from "../config/app.config";
import type {
  CheckoutRequestResult,
  CreateCheckoutRequest,
  PaymentCheckoutProvider,
} from "./interfaces/payment-checkout-provider.interface";

@Injectable()
export class StripeCheckoutProvider implements PaymentCheckoutProvider {
  constructor(
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  async createCheckout(
    request: CreateCheckoutRequest,
  ): Promise<CheckoutRequestResult> {
    const secretKey = this.secretKey();
    const successUrl = this.returnUrl("success");
    const cancelUrl = this.returnUrl("cancel");

    try {
      const response = await fetch(
        "https://api.stripe.com/v1/checkout/sessions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secretKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "Stripe-Account": request.connectedAccountId,
            "Idempotency-Key": request.idempotencyKey,
          },
          body: this.checkoutBody(request, successUrl, cancelUrl),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new Error("Stripe Checkout request failed.");
      const session = (await response.json()) as Record<string, unknown>;

      if (
        typeof session.id !== "string" ||
        typeof session.url !== "string" ||
        typeof session.expires_at !== "number"
      ) {
        throw new Error("Stripe Checkout returned an invalid response.");
      }

      return {
        sessionId: session.id,
        paymentIntentId:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : null,
        checkoutUrl: session.url,
        expiresAt: new Date(session.expires_at * 1000),
      };
    } catch {
      throw new ServiceUnavailableException(
        "Secure payment checkout is temporarily unavailable.",
      );
    }
  }

  private secretKey(): string {
    if (!this.config.stripeSecretKey) {
      throw new ServiceUnavailableException(
        "Secure payment checkout is not configured.",
      );
    }
    return this.config.stripeSecretKey;
  }

  private returnUrl(outcome: "success" | "cancel"): string {
    const url = new URL(this.config.customerPaymentReturnUrl);
    url.searchParams.set("payment", outcome);
    return url.toString();
  }

  private checkoutBody(
    request: CreateCheckoutRequest,
    successUrl: string,
    cancelUrl: string,
  ): URLSearchParams {
    return new URLSearchParams({
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: request.paymentRequestId,
      "metadata[tenantId]": request.tenantId,
      "metadata[jobId]": request.jobId,
      "metadata[paymentRequestId]": request.paymentRequestId,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": request.currency,
      "line_items[0][price_data][unit_amount]": String(
        request.amountTotalCents,
      ),
      "line_items[0][price_data][product_data][name]": request.label,
      "payment_intent_data[metadata][tenantId]": request.tenantId,
      "payment_intent_data[metadata][jobId]": request.jobId,
      "payment_intent_data[metadata][paymentRequestId]":
        request.paymentRequestId,
    });
  }
}
