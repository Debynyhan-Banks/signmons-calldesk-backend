-- Inactive mocked VO-2; local disposable migration only.
ALTER TABLE "AddressVerificationOperation" ADD COLUMN "executionDeadline" TIMESTAMPTZ(3);
