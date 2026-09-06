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

export type RecoverCheckoutRequest = {
  connectedAccountId: string;
  sessionId: string;
};

export type RecoverCheckoutResult = {
  checkoutUrl: string;
  expiresAt: Date;
};

export interface PaymentCheckoutProvider {
  createCheckout(
    request: CreateCheckoutRequest,
  ): Promise<CheckoutRequestResult>;
  recoverCheckout(
    request: RecoverCheckoutRequest,
  ): Promise<RecoverCheckoutResult | null>;
}
