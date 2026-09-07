ALTER TYPE "CommunicationStatus" ADD VALUE 'SENDING';
ALTER TYPE "CommunicationStatus" ADD VALUE 'DEAD_LETTER';

ALTER TABLE "CommunicationEvent"
ADD COLUMN "idempotencyKeyHash" TEXT,
ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN "lastErrorCode" TEXT,
ADD COLUMN "terminalAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "CommunicationEvent_tenantId_idempotencyKeyHash_key"
ON "CommunicationEvent"("tenantId", "idempotencyKeyHash");

CREATE UNIQUE INDEX "CommunicationEvent_tenantId_provider_externalId_key"
ON "CommunicationEvent"("tenantId", "provider", "externalId");

CREATE INDEX "CommunicationEvent_status_nextAttemptAt_idx"
ON "CommunicationEvent"("status", "nextAttemptAt");
