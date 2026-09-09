-- Forward-only, no historical event reconstruction or delivery activation.
CREATE TABLE "AppointmentCancellationSnapshot" (
  "tenantId" UUID NOT NULL,
  "jobId" UUID NOT NULL,
  "claimedUpdatedAt" TIMESTAMP(3) NOT NULL,
  "previousUpdatedAt" TIMESTAMP(3) NOT NULL,
  "customerId" UUID NOT NULL,
  "intakeSessionId" VARCHAR(64),
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "calendarEventHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppointmentCancellationSnapshot_pkey" PRIMARY KEY ("tenantId", "jobId", "claimedUpdatedAt"),
  CONSTRAINT "AppointmentCancellationSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "TenantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AppointmentCancellationSnapshot_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AppointmentCancellationSnapshot_shape_check" CHECK ("windowEnd" > "windowStart" AND "claimedUpdatedAt" > "previousUpdatedAt" AND "calendarEventHash" ~ '^[0-9a-f]{64}$')
);
CREATE TRIGGER "AppointmentCancellationSnapshot_immutable" BEFORE UPDATE ON "AppointmentCancellationSnapshot"
FOR EACH ROW EXECUTE FUNCTION reject_appointment_email_intent_update();
ALTER TABLE "AppointmentEmailIntent" DROP CONSTRAINT "AppointmentEmailIntent_shape_check";
ALTER TABLE "AppointmentEmailIntent" ADD CONSTRAINT "AppointmentEmailIntent_shape_check"
  CHECK ("version" = 1 AND "kind" IN ('APPOINTMENT_CONFIRMED', 'APPOINTMENT_RESCHEDULED', 'APPOINTMENT_CANCELLED') AND "state" = 'RECORDED' AND "preference" IN ('BLOCKED', 'PERMITTED', 'INVALID'));
ALTER TABLE "AppointmentEmailIntent" DROP CONSTRAINT "AppointmentEmailIntent_source_check";
ALTER TABLE "AppointmentEmailIntent" ADD CONSTRAINT "AppointmentEmailIntent_source_check"
  CHECK (("source" = 'CALENDAR_ACK' AND "calendarOperationId" IS NULL) OR ("source" = 'CREATE_READBACK' AND "calendarOperationId" IS NOT NULL AND "kind" = 'APPOINTMENT_CONFIRMED'));
