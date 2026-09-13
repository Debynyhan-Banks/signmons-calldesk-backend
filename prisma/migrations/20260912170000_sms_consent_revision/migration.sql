ALTER TABLE "SmsConsentRecord" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "SmsConsentRecord" ADD CONSTRAINT "SmsConsentRecord_revision_positive" CHECK ("revision" > 0);

CREATE FUNCTION sms_consent_revision_increment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."revision" := OLD."revision" + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sms_consent_revision_update BEFORE UPDATE ON "SmsConsentRecord"
FOR EACH ROW EXECUTE FUNCTION sms_consent_revision_increment();
