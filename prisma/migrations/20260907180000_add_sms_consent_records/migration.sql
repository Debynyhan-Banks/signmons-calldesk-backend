CREATE TYPE "SmsConsentStatus" AS ENUM ('OPTED_IN', 'OPTED_OUT');
CREATE TYPE "SmsConsentSource" AS ENUM ('VERBAL', 'KEYWORD');

CREATE TABLE "SmsConsentRecord" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "status" "SmsConsentStatus" NOT NULL,
    "source" "SmsConsentSource" NOT NULL,
    "disclosureVersion" TEXT NOT NULL,
    "evidenceAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmsConsentRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SmsConsentRecord_tenantId_phoneHash_key"
ON "SmsConsentRecord"("tenantId", "phoneHash");

CREATE INDEX "SmsConsentRecord_tenantId_status_idx"
ON "SmsConsentRecord"("tenantId", "status");

ALTER TABLE "SmsConsentRecord"
ADD CONSTRAINT "SmsConsentRecord_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "TenantOrganization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
