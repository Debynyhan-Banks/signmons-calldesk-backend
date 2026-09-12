CREATE TABLE "SmsPolicyCapture" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "sessionId" VARCHAR(64) NOT NULL,
  "policyVersionId" UUID NOT NULL,
  "policyRevision" INTEGER NOT NULL CHECK ("policyRevision" > 0),
  "phoneHash" CHAR(64) NOT NULL,
  "hashKeyVersion" VARCHAR(64) NOT NULL,
  "consentRevision" INTEGER NOT NULL CHECK ("consentRevision" >= 0),
  "mode" VARCHAR(16) NOT NULL DEFAULT 'DRY_RUN' CHECK ("mode" = 'DRY_RUN'),
  "encryptedSnapshot" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "recordedAt" TIMESTAMP(3),
  "sourceAuditId" UUID,
  CHECK ("expiresAt" > "issuedAt" AND "expiresAt" <= "issuedAt" + INTERVAL '5 minutes'),
  CHECK (("recordedAt" IS NULL AND "sourceAuditId" IS NULL) OR
    ("recordedAt" IS NOT NULL AND "sourceAuditId" IS NOT NULL AND "recordedAt" >= "issuedAt" AND "recordedAt" < "expiresAt")),
  FOREIGN KEY ("conversationId", "tenantId") REFERENCES "Conversation" ("id", "tenantId") ON DELETE RESTRICT,
  FOREIGN KEY ("policyVersionId", "tenantId") REFERENCES "TenantSmsPolicyVersion" ("id", "tenantId") ON DELETE RESTRICT,
  FOREIGN KEY ("sourceAuditId", "tenantId") REFERENCES "AuditLog" ("id", "tenantId") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "SmsPolicyCapture_sourceAuditId_tenantId_key" ON "SmsPolicyCapture" ("sourceAuditId", "tenantId");
CREATE INDEX "SmsPolicyCapture_tenantId_conversationId_sessionId_idx" ON "SmsPolicyCapture" ("tenantId", "conversationId", "sessionId");
CREATE FUNCTION sms_policy_capture_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'recordedAt' - 'sourceAuditId') IS DISTINCT FROM (to_jsonb(OLD) - 'recordedAt' - 'sourceAuditId')
     OR (OLD."recordedAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'SMS capture provenance and captured receipt are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sms_policy_capture_immutable_update BEFORE UPDATE ON "SmsPolicyCapture"
FOR EACH ROW EXECUTE FUNCTION sms_policy_capture_immutable();
