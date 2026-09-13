-- Additive foundation only; no backfill or runtime activation. Apply to a
-- disposable local database until a separate release approval is granted.
CREATE TYPE "CalendarOperationAction" AS ENUM ('CREATE', 'RESCHEDULE', 'CANCEL');
CREATE TYPE "CalendarOperationStatus" AS ENUM ('PENDING', 'UNCERTAIN', 'APPLIED', 'NEEDS_REVIEW', 'FINALIZED', 'ABORTED');

CREATE TABLE "CalendarOperation" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "jobId" UUID NOT NULL,
  "action" "CalendarOperationAction" NOT NULL,
  "status" "CalendarOperationStatus" NOT NULL DEFAULT 'PENDING',
  "calendarId" VARCHAR(1024) NOT NULL,
  "calendarEventId" VARCHAR(256) NOT NULL,
  "timeZone" VARCHAR(128) NOT NULL,
  "expectedUpdatedAt" TIMESTAMP(3) NOT NULL,
  "claimedUpdatedAt" TIMESTAMP(3) NOT NULL,
  "previousStatus" "JobStatus" NOT NULL,
  "previousCalendarEventId" VARCHAR(256),
  "previousWindowStart" TIMESTAMP(3),
  "previousWindowEnd" TIMESTAMP(3),
  "previousTimeText" VARCHAR(160),
  "desiredWindowStart" TIMESTAMP(3),
  "desiredWindowEnd" TIMESTAMP(3),
  "desiredTimeText" VARCHAR(160),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CalendarOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CalendarOperation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "TenantOrganization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CalendarOperation_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CalendarOperation_version_check" CHECK ("claimedUpdatedAt" > "expectedUpdatedAt"),
  CONSTRAINT "CalendarOperation_terminal_check" CHECK (("status" IN ('FINALIZED', 'ABORTED')) = ("finishedAt" IS NOT NULL)),
  CONSTRAINT "CalendarOperation_identity_check" CHECK (length(btrim("calendarId")) > 0 AND length(btrim("calendarEventId")) > 0 AND length(btrim("timeZone")) > 0),
  CONSTRAINT "CalendarOperation_previous_check" CHECK (
    ("action" = 'CREATE' AND "previousStatus" = 'CREATED' AND "previousCalendarEventId" IS NULL AND "previousWindowStart" IS NULL AND "previousWindowEnd" IS NULL)
    OR ("action" IN ('RESCHEDULE', 'CANCEL') AND "previousStatus" = 'ACCEPTED' AND "previousCalendarEventId" IS NOT NULL AND "calendarEventId" = "previousCalendarEventId" AND "previousWindowStart" IS NOT NULL AND "previousWindowEnd" IS NOT NULL AND "previousWindowEnd" > "previousWindowStart")
  ),
  CONSTRAINT "CalendarOperation_desired_check" CHECK (
    ("action" = 'CANCEL' AND "desiredWindowStart" IS NULL AND "desiredWindowEnd" IS NULL AND "desiredTimeText" IS NULL)
    OR ("action" IN ('CREATE', 'RESCHEDULE') AND "desiredWindowStart" IS NOT NULL AND "desiredWindowEnd" IS NOT NULL AND "desiredWindowEnd" > "desiredWindowStart" AND "desiredTimeText" IS NOT NULL AND length(btrim("desiredTimeText")) > 0)
  ),
  CONSTRAINT "CalendarOperation_create_id_check" CHECK ("action" <> 'CREATE' OR "calendarEventId" ~ '^[0-9a-f]{32}$')
);
CREATE UNIQUE INDEX "CalendarOperation_id_tenantId_key" ON "CalendarOperation"("id", "tenantId");
-- NEEDS_REVIEW and UNCERTAIN remain blocking, not permission to try again.
CREATE UNIQUE INDEX "CalendarOperation_one_unfinished_job" ON "CalendarOperation"("tenantId", "jobId") WHERE "finishedAt" IS NULL;
CREATE INDEX "CalendarOperation_tenantId_createdAt_idx" ON "CalendarOperation"("tenantId", "createdAt");
CREATE INDEX "CalendarOperation_status_createdAt_idx" ON "CalendarOperation"("status", "createdAt");
