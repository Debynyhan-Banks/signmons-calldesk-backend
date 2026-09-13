-- Unknown location is NULL, never a fabricated provider identifier or coordinate.
-- Preserve existing values, relations and the tenant/place uniqueness constraint.
ALTER TABLE "PropertyAddress"
  ALTER COLUMN "googlePlaceId" DROP NOT NULL,
  ALTER COLUMN "latitude" DROP NOT NULL,
  ALTER COLUMN "longitude" DROP NOT NULL;
