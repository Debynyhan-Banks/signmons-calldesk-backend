ALTER TABLE "User" ADD COLUMN "isOnCall" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "RoutingRuleStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "RoutingTimeScope" AS ENUM ('ANY', 'BUSINESS_HOURS', 'AFTER_HOURS');

CREATE TABLE "RoutingRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "RoutingRuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "serviceCategoryId" UUID,
    "serviceCategoryTenantId" UUID,
    "serviceAreaId" UUID,
    "serviceAreaTenantId" UUID,
    "urgency" "JobUrgency",
    "timeScope" "RoutingTimeScope" NOT NULL DEFAULT 'ANY',
    "requireAvailable" BOOLEAN NOT NULL DEFAULT true,
    "requireOnCall" BOOLEAN NOT NULL DEFAULT false,
    "escalateToOwner" BOOLEAN NOT NULL DEFAULT false,
    "escalateToOnCall" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RoutingRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RoutingRule_id_tenantId_key" ON "RoutingRule"("id", "tenantId");
CREATE INDEX "RoutingRule_tenantId_status_priority_idx" ON "RoutingRule"("tenantId", "status", "priority");
CREATE INDEX "RoutingRule_serviceCategoryId_serviceCategoryTenantId_idx" ON "RoutingRule"("serviceCategoryId", "serviceCategoryTenantId");
CREATE INDEX "RoutingRule_serviceAreaId_serviceAreaTenantId_idx" ON "RoutingRule"("serviceAreaId", "serviceAreaTenantId");

ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "TenantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_serviceCategoryId_serviceCategoryTenantId_fkey" FOREIGN KEY ("serviceCategoryId", "serviceCategoryTenantId") REFERENCES "ServiceCategory"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_serviceAreaId_serviceAreaTenantId_fkey" FOREIGN KEY ("serviceAreaId", "serviceAreaTenantId") REFERENCES "ServiceArea"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
