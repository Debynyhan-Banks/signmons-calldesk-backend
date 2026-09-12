-- Inactive registry; this section executes only against a disposable local database.
CREATE TABLE "TenantSmsPolicyVersion" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL REFERENCES "TenantOrganization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "content" JSONB NOT NULL, "digest" CHAR(64) NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("id", "tenantId")
);
CREATE TABLE "TenantSmsPolicyHead" (
 "tenantId" UUID PRIMARY KEY REFERENCES "TenantOrganization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "versionId" UUID NOT NULL, "revision" INTEGER NOT NULL CHECK ("revision" > 0),
 "state" VARCHAR(32) NOT NULL CHECK ("state" IN ('DRAFT','REVIEWED','PUBLISHED_VERIFIED','CAPTURE_ELIGIBLE','SUSPENDED')),
 "publicationRef" VARCHAR(120), "lastAuditId" UUID NOT NULL,
 FOREIGN KEY ("versionId", "tenantId") REFERENCES "TenantSmsPolicyVersion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("lastAuditId", "tenantId") REFERENCES "AuditLog"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CHECK ("state" NOT IN ('PUBLISHED_VERIFIED','CAPTURE_ELIGIBLE') OR "publicationRef" IS NOT NULL)
);
CREATE FUNCTION immutable_sms_policy_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SMS policy versions are immutable'; END $$;
CREATE TRIGGER immutable_sms_policy_version BEFORE UPDATE OR DELETE ON "TenantSmsPolicyVersion"
FOR EACH ROW EXECUTE FUNCTION immutable_sms_policy_version();
