-- APP-009 keeps technician progress separate from the customer-facing job lifecycle.
CREATE TYPE "TechnicianJobStatus" AS ENUM (
  'ASSIGNED',
  'ACCEPTED',
  'EN_ROUTE',
  'IN_PROGRESS',
  'COMPLETED'
);

ALTER TABLE "Job"
  ADD COLUMN "technicianStatus" "TechnicianJobStatus",
  ADD COLUMN "technicianStatusUpdatedAt" TIMESTAMP(3);

UPDATE "Job"
SET
  "technicianStatus" = CASE
    WHEN "status" = 'COMPLETED' THEN 'COMPLETED'::"TechnicianJobStatus"
    WHEN "status" = 'IN_PROGRESS' THEN 'IN_PROGRESS'::"TechnicianJobStatus"
    ELSE 'ASSIGNED'::"TechnicianJobStatus"
  END,
  "technicianStatusUpdatedAt" = "updatedAt"
WHERE "assignedUserId" IS NOT NULL;

CREATE INDEX "Job_tenantId_assignedUserId_technicianStatus_idx"
  ON "Job"("tenantId", "assignedUserId", "technicianStatus");
