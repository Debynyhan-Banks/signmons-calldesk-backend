CREATE TYPE "SmsEnqueueIntentStatus" AS ENUM ('PENDING', 'QUEUED', 'STALE', 'FAILED');

CREATE TABLE "SmsEnqueueIntent" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "jobId" UUID NOT NULL,
  "templateKey" VARCHAR(64) NOT NULL,
  "stateHash" VARCHAR(64) NOT NULL,
  "status" "SmsEnqueueIntentStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastErrorCode" VARCHAR(64),
  "communicationEventId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SmsEnqueueIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SmsEnqueueIntent_attemptCount_check" CHECK ("attemptCount" >= 0 AND "attemptCount" <= 5),
  CONSTRAINT "SmsEnqueueIntent_stateHash_check" CHECK ("stateHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "SmsEnqueueIntent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "TenantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SmsEnqueueIntent_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SmsEnqueueIntent_communicationEventId_tenantId_fkey" FOREIGN KEY ("communicationEventId", "tenantId") REFERENCES "CommunicationEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SmsEnqueueIntent_id_tenantId_key" ON "SmsEnqueueIntent"("id", "tenantId");
CREATE UNIQUE INDEX "SmsEnqueueIntent_tenantId_jobId_templateKey_stateHash_key" ON "SmsEnqueueIntent"("tenantId", "jobId", "templateKey", "stateHash");
CREATE INDEX "SmsEnqueueIntent_status_nextAttemptAt_idx" ON "SmsEnqueueIntent"("status", "nextAttemptAt");
CREATE INDEX "SmsEnqueueIntent_tenantId_createdAt_idx" ON "SmsEnqueueIntent"("tenantId", "createdAt");
