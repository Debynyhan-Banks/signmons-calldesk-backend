-- Inactive foundation only. No backfill, evidence import, queue or production activation.
-- RESTRICT protects proof from independent conversation/audit/job retention until
-- the approved 90-day policy and legal-hold compatibility are implemented.
CREATE TABLE "AppointmentEmailConsentScope" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "conversationId" UUID NOT NULL,
 "sessionId" VARCHAR(64) NOT NULL CHECK (length(btrim("sessionId")) > 0),
 "intakeCustomerId" UUID NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("id","tenantId"), UNIQUE ("tenantId","conversationId"), UNIQUE ("tenantId","sessionId"),
 FOREIGN KEY ("tenantId") REFERENCES "TenantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY ("conversationId","tenantId") REFERENCES "Conversation"("id","tenantId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "AppointmentEmailConsentEvidence" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "scopeId" UUID NOT NULL,
 "sourceAuditId" UUID NOT NULL, "revision" INTEGER NOT NULL CHECK ("revision" > 0),
 "decision" VARCHAR(16) NOT NULL CHECK ("decision" IN ('GRANTED','DECLINED','REVOKED')),
 "purpose" VARCHAR(32) NOT NULL DEFAULT 'APPOINTMENT_UPDATES_V1' CHECK ("purpose" = 'APPOINTMENT_UPDATES_V1'),
 "promptVersion" VARCHAR(32) NOT NULL CHECK ("promptVersion" = 'APPOINTMENT_EMAIL_OPT_IN_V1'),
 "interactionId" UUID NOT NULL, "encryptedEmail" TEXT NOT NULL CHECK (length("encryptedEmail") > 0),
 "mailboxFingerprint" CHAR(64) NOT NULL CHECK ("mailboxFingerprint" ~ '^[0-9a-f]{64}$'),
 "fingerprintKeyVersion" VARCHAR(32) NOT NULL CHECK ("fingerprintKeyVersion" ~ '^[a-zA-Z0-9_-]{1,32}$'),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("scopeId","revision"), UNIQUE ("sourceAuditId","tenantId"), UNIQUE ("tenantId","interactionId"),
 FOREIGN KEY ("scopeId","tenantId") REFERENCES "AppointmentEmailConsentScope"("id","tenantId") ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY ("sourceAuditId","tenantId") REFERENCES "AuditLog"("id","tenantId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "AppointmentEmailConsentBinding" (
 "scopeId" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "jobId" UUID NOT NULL UNIQUE,
 "jobCustomerId" UUID NOT NULL, "originLinkId" UUID NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("scopeId","tenantId"), UNIQUE ("jobId","tenantId"),
 FOREIGN KEY ("scopeId","tenantId") REFERENCES "AppointmentEmailConsentScope"("id","tenantId") ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY ("jobId","tenantId") REFERENCES "Job"("id","tenantId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE FUNCTION reject_appointment_email_consent_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Appointment email consent evidence is immutable' USING ERRCODE = '55000'; END;
$$;
CREATE TRIGGER "AppointmentEmailConsentScope_immutable" BEFORE UPDATE ON "AppointmentEmailConsentScope"
 FOR EACH ROW EXECUTE FUNCTION reject_appointment_email_consent_update();
CREATE TRIGGER "AppointmentEmailConsentEvidence_immutable" BEFORE UPDATE ON "AppointmentEmailConsentEvidence"
 FOR EACH ROW EXECUTE FUNCTION reject_appointment_email_consent_update();
CREATE TRIGGER "AppointmentEmailConsentBinding_immutable" BEFORE UPDATE ON "AppointmentEmailConsentBinding"
 FOR EACH ROW EXECUTE FUNCTION reject_appointment_email_consent_update();
-- Serialize even direct insertions; current-state projection is latest immutable
-- revision, avoiding a mutable projection that can disagree with its ledger.
CREATE FUNCTION enforce_appointment_email_consent_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected INTEGER;
BEGIN
 PERFORM 1 FROM "AppointmentEmailConsentScope" WHERE id = NEW."scopeId" AND "tenantId" = NEW."tenantId" FOR UPDATE;
 SELECT COALESCE(MAX(revision),0)+1 INTO expected FROM "AppointmentEmailConsentEvidence" WHERE "scopeId" = NEW."scopeId";
 IF NEW.revision <> expected THEN RAISE EXCEPTION 'Consent revision must advance once' USING ERRCODE = '23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER "AppointmentEmailConsentEvidence_revision" BEFORE INSERT ON "AppointmentEmailConsentEvidence"
 FOR EACH ROW EXECUTE FUNCTION enforce_appointment_email_consent_revision();
