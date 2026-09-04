export type CreateCheckoutRequest = {
  tenantId: string;
  jobId: string;
  paymentRequestId: string;
  connectedAccountId: string;
  idempotencyKey: string;
  amountTotalCents: number;
  currency: string;
  label: string;
};

export type CheckoutRequestResult = {
  sessionId: string;
  paymentIntentId: string | null;
  checkoutUrl: string;
  expiresAt: Date;
};

export interface PaymentCheckoutProvider {
  createCheckout(
    request: CreateCheckoutRequest,
  ): Promise<CheckoutRequestResult>;
}
