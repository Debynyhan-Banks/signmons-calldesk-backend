-- Inactive fixture-only storage. Apply only to disposable local databases until separately released.
CREATE TABLE "FixtureSmsConsentState" (
  "tenantId" UUID NOT NULL, "conversationId" UUID NOT NULL, "sessionId" VARCHAR(64) NOT NULL,
  "encryptedPolicy" TEXT NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  PRIMARY KEY ("tenantId", "conversationId"),
  UNIQUE ("conversationId", "tenantId"),
  UNIQUE ("tenantId", "conversationId", "sessionId"),
  FOREIGN KEY ("conversationId", "tenantId") REFERENCES "Conversation"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "FixtureSmsConsentPrompt" (
  "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "conversationId" UUID NOT NULL,
  "sessionId" VARCHAR(64) NOT NULL, "encryptedSnapshot" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "recordedAt" TIMESTAMP(3), "sourceAuditId" UUID,
  FOREIGN KEY ("tenantId", "conversationId", "sessionId") REFERENCES "FixtureSmsConsentState"("tenantId", "conversationId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("sourceAuditId", "tenantId") REFERENCES "AuditLog"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE ("sourceAuditId", "tenantId"),
  CHECK ("expiresAt" > "issuedAt" AND "expiresAt" <= "issuedAt" + INTERVAL '5 minutes'),
  CHECK (("recordedAt" IS NULL AND "sourceAuditId" IS NULL) OR
    ("recordedAt" IS NOT NULL AND "sourceAuditId" IS NOT NULL AND "recordedAt" >= "issuedAt" AND "recordedAt" < "expiresAt"))
);
CREATE INDEX "FixtureSmsConsentPrompt_tenantId_conversationId_expiresAt_idx" ON "FixtureSmsConsentPrompt"("tenantId", "conversationId", "expiresAt");
CREATE FUNCTION fixture_sms_state_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW."revision" := OLD."revision" + 1; RETURN NEW; END $$;
CREATE TRIGGER fixture_sms_state_revision BEFORE UPDATE ON "FixtureSmsConsentState"
FOR EACH ROW EXECUTE FUNCTION fixture_sms_state_revision();
