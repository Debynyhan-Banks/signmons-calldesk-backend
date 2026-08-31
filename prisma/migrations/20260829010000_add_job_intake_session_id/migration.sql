ALTER TABLE "Job"
ADD COLUMN "intakeSessionId" VARCHAR(64);

CREATE UNIQUE INDEX "Job_tenantId_intakeSessionId_key"
ON "Job"("tenantId", "intakeSessionId");
