-- APP-012: retain only the bounded metadata needed to make checkout requests
-- idempotent and operator-trackable. Checkout URLs and secrets are not stored.
ALTER TABLE "Payment"
ADD COLUMN "requestKeyHash" VARCHAR(64),
ADD COLUMN "checkoutExpiresAt" TIMESTAMP(3),
ADD COLUMN "requestedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Payment_tenantId_requestKeyHash_key"
ON "Payment"("tenantId", "requestKeyHash");
