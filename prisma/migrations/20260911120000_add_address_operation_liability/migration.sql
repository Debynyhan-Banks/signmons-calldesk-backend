-- Inactive VO-1 only; approved for disposable local application, not production.
CREATE TABLE "AddressVerificationOperation" (
 "id" UUID PRIMARY KEY, "accountId" UUID NOT NULL, "tenantId" UUID NOT NULL,
 "conversationId" UUID NOT NULL, "sessionId" UUID NOT NULL, "intentId" UUID NOT NULL,
 "revision" INTEGER NOT NULL CHECK ("revision" >= 1), "policyHash" TEXT NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'RESERVED' CHECK ("state" IN ('RESERVED','DISPATCH_CLAIMED','OBSERVED','UNCERTAIN','CANCELLED')),
 "heldMicros" BIGINT NOT NULL CHECK ("heldMicros" >= 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "attemptId" UUID,
 CHECK (("state" IN ('RESERVED','CANCELLED') AND "attemptId" IS NULL) OR
        ("state" IN ('DISPATCH_CLAIMED','OBSERVED','UNCERTAIN') AND "attemptId" IS NOT NULL)),
 CHECK (("state" = 'CANCELLED' AND "heldMicros" = 0) OR ("state" <> 'CANCELLED' AND "heldMicros" > 0))
);
CREATE UNIQUE INDEX "AddressOperation_binding_key"
 ON "AddressVerificationOperation" ("accountId","tenantId","sessionId","intentId","revision","policyHash");
CREATE INDEX "AddressVerificationOperation_accountId_state_idx" ON "AddressVerificationOperation" ("accountId","state");
CREATE TABLE "AddressVerificationRequest" (
 "id" UUID PRIMARY KEY, "operationId" UUID NOT NULL REFERENCES "AddressVerificationOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
