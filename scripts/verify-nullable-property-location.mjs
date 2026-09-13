// Local-only migration regression. Never reads DATABASE_URL or connects to a host.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = process.env.LOCAL_POSTGRES_BIN;
if (!bin) throw Error('Set LOCAL_POSTGRES_BIN to local PostgreSQL binaries');
const root = mkdtempSync(join(tmpdir(), 'signmons-location-test-'));
const data = join(root, 'data');
const run = (name, args, input) => execFileSync(join(bin,name),args,{
  input, encoding:'utf8', env:{PATH:process.env.PATH, LC_ALL:'C'},
  stdio:['pipe','pipe','pipe'],
});
let started = false;
try {
  run('initdb',['-D',data,'-A','trust','-U','local_test','--no-locale']);
  run('pg_ctl',['-D',data,'-l',join(root,'postgres.log'),'-o',`-k ${root} -c listen_addresses=''`,'-w','start']);
  started = true;
  const migration = readFileSync(fileURLToPath(new URL('../prisma/migrations/20260913180000_nullable_property_location/migration.sql',import.meta.url)),'utf8');
  run('psql',['-h',root,'-U','local_test','-d','postgres','-v','ON_ERROR_STOP=1'],`
CREATE TABLE "PropertyAddress" (
  id text PRIMARY KEY, "tenantId" text NOT NULL, "googlePlaceId" text NOT NULL,
  latitude double precision NOT NULL, longitude double precision NOT NULL,
  UNIQUE ("tenantId", "googlePlaceId")
);
INSERT INTO "PropertyAddress" VALUES ('existing','tenant','real-place',41.5,-81.6);
${migration}
INSERT INTO "PropertyAddress" VALUES ('unknown-1','tenant',NULL,NULL,NULL),('unknown-2','tenant',NULL,NULL,NULL);
INSERT INTO "PropertyAddress" VALUES ('other-tenant','other','real-place',41.5,-81.6);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "PropertyAddress" WHERE id='existing' AND "googlePlaceId"='real-place' AND latitude=41.5 AND longitude=-81.6) THEN RAISE EXCEPTION 'existing values changed'; END IF;
  IF (SELECT count(*) FROM "PropertyAddress" WHERE "googlePlaceId" IS NULL AND latitude IS NULL AND longitude IS NULL) <> 2 THEN RAISE EXCEPTION 'unknown locations not retained'; END IF;
  BEGIN
    INSERT INTO "PropertyAddress" VALUES ('duplicate','tenant','real-place',1,1);
    RAISE EXCEPTION 'tenant uniqueness lost';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
`);
  console.log('PASS: targeted PostgreSQL migration preserves values and tenant uniqueness; multiple unknown locations allowed.');
} finally {
  if (started) run('pg_ctl',['-D',data,'-m','fast','-w','stop']);
  console.log(`Stopped disposable database; synthetic evidence retained at ${root}`);
}
