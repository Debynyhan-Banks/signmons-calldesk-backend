-- Additive, no backfill. Apply only in the disposable fixture until release approval.
-- Existing rows use updatedAt + reader grace until explicit reviewed admission.
ALTER TABLE "CalendarOperation" ADD COLUMN "readbackNotBefore" TIMESTAMP(3);
