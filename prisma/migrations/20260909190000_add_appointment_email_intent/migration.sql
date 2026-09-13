-- Recording only. No backfill or delivery activation. Snapshots are immutable;
-- retention may delete through existing tenant/job/audit cascades.
CREATE TABLE "AppointmentEmailIntent" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "jobId" UUID NOT NULL,
  "sourceAuditId" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "kind" VARCHAR(64) NOT NULL DEFAULT 'APPOINTMENT_CONFIRMED',
  "state" VARCHAR(32) NOT NULL DEFAULT 'RECORDED',
  "source" VARCHAR(32) NOT NULL,
  "calendarOperationId" UUID,
  "customerId" UUID NOT NULL,
  "intakeSessionId" VARCHAR(64),
  "jobUpdatedAt" TIMESTAMP(3) NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "calendarEventHash" CHAR(64) NOT NULL,
  "tenantSettingsUpdatedAt" TIMESTAMP(3) NOT NULL,
  "preference" VARCHAR(16) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppointmentEmailIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AppointmentEmailIntent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "TenantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AppointmentEmailIntent_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AppointmentEmailIntent_sourceAuditId_tenantId_fkey" FOREIGN KEY ("sourceAuditId", "tenantId") REFERENCES "AuditLog"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AppointmentEmailIntent_shape_check" CHECK ("version" = 1 AND "kind" = 'APPOINTMENT_CONFIRMED' AND "state" = 'RECORDED' AND "preference" IN ('BLOCKED', 'PERMITTED', 'INVALID')),
  CONSTRAINT "AppointmentEmailIntent_window_check" CHECK ("windowEnd" > "windowStart"),
  CONSTRAINT "AppointmentEmailIntent_hash_check" CHECK ("calendarEventHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AppointmentEmailIntent_source_check" CHECK (("source" = 'CALENDAR_ACK' AND "calendarOperationId" IS NULL) OR ("source" = 'CREATE_READBACK' AND "calendarOperationId" IS NOT NULL))
);
CREATE UNIQUE INDEX "AppointmentEmailIntent_sourceAuditId_tenantId_key" ON "AppointmentEmailIntent"("sourceAuditId", "tenantId");
CREATE UNIQUE INDEX "AppointmentEmailIntent_tenantId_jobId_kind_jobUpdatedAt_key" ON "AppointmentEmailIntent"("tenantId", "jobId", "kind", "jobUpdatedAt");
CREATE INDEX "AppointmentEmailIntent_tenantId_createdAt_idx" ON "AppointmentEmailIntent"("tenantId", "createdAt");
CREATE FUNCTION reject_appointment_email_intent_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Appointment email event snapshots are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER "AppointmentEmailIntent_immutable" BEFORE UPDATE ON "AppointmentEmailIntent"
FOR EACH ROW EXECUTE FUNCTION reject_appointment_email_intent_update();
