ALTER TABLE "Job"
ADD COLUMN "calendarEventId" VARCHAR(256);

CREATE UNIQUE INDEX "Job_tenantId_serviceWindowStart_serviceWindowEnd_key"
ON "Job"("tenantId", "serviceWindowStart", "serviceWindowEnd");
