# P06-R01 — synthetic old-schema upgrade rehearsal

Owner approved baseline v1 and continuation, requiring a stop for material questions. Entry backend0744d3c/governance4bde29b. Pre-code card: governance APP013_P06_R01_REHEARSAL_CARD.md. Runtime and all26 migration files remain unchanged from53037fb. Only a local verification script, evidence and governance reporting changed. No scope deviation.

## Results

Installed Prisma7.10.0; local PostgreSQL16.11, Unix socket /tmp only. Script creates random validated calldesk_p06_* databases; it does not accept a database URL, load dotenv, fetch secrets or call providers. Child environment is allowlisted. Temporary exports contain exact checksum-verified migration copies and generated local-only config.

- Actual Prisma migrate deploy applied the first13 migrations and recorded matching successful history. Fictional tenant/customer/property/opted-out consent rows were inserted in that older schema.
- Pending13 migrated successfully; all26 names/checksums matched. Existing property fields and consent fields were byte/value-equivalent through the upgrade; new consent revision was1. A no-op update advanced it to2; attempted manual revision99 became3 via the trigger. Location fields accepted null after migration.
- Invalid revision0, duplicate tenant/phone hash and foreign customer reference were refused by actual CHECK/UNIQUE/FK constraints. Policy-version UPDATE and DELETE were refused by the immutable trigger.
- Second deploy reported no pending migrations and did not add history rows.
- Catalog matched an independently created all26-migration database:423 columns,159 constraints,154 indexes,10 non-internal triggers,7 functions and134 enum values. Catalog parity checks definitions, not only object counts. Existing DB/browser and full unit regressions additionally exercise application behavior; this is not a claim to exhaust every possible SQL input or certify the live database's drift.
- A third old-schema database deliberately held ACCESS EXCLUSIVE on SmsConsentRecord while the actual Prisma process attempted upgrade. URL connection options carried lock_timeout5s and statement_timeout60s. The run failed with lock timeout after approximately5.5s;23 migrations remained successful and the24th (sms_consent_revision) was unfinished. Revision column was absent; final two migrations were not executed. This demonstrates persisted earlier migrations, not all-files rollback. No migrate resolve, automatic retry or lock-holder termination was used. The holder was rolled back by its owning test connection.
- Five-second lock timeout was exercised on an actual migration connection. The60-second statement timeout was configured but not separately duration-tested; the120-second local child watchdog did not fire. These are local results, not qualification of a Neon pooler or future live runner; R02/R03 retain that target-specific gate.
- All three run-owned databases were dropped after clients closed; a final local catalog query showed no calldesk_p06_* database remaining. Only fictional disposable data was removed; logs/manifest remain for review, and the test is reproducible. Nothing in staging was read or changed.

Final evidence: /private/tmp/signmons-p06-upgrade-ZZYHzw/report.json, manifest.json and deploy logs. Earlier development runs Q1bD4E and Co2ocI also cleaned up; the first revealed a nonfailing pg query-concurrency warning in the new catalog reader, fixed by serial queries before final rerun. No migration failure was hidden: intentional lock failure is asserted and retained in the report.

## Validation and reproduction

Run from focused backend:

1. node --check scripts/verify-p06-migration-upgrade.mjs; node scripts/verify-p06-migration-upgrade.mjs
2. npm run build; npm run lint; npm test -- --runInBand — passed2359, skipped3;129 suites passed,1 skipped.
3. ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-p06-r01-browser PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs — passed, owned DB cleaned. Existing eight loaded browser cases at390/1440 passed; synthetic providers only, zero live calls. No new UI behavior claimed. Existing harness pg deprecation warning remains nonfatal.
4. Architecture and Prisma validation passed; governance frozen/full consistency,21 regressions, backend governance check and whitespace passed. No dependency changes; no fresh dependency-audit result claimed.

Logs: /private/tmp/signmons-p06-r01-{upgrade,build,lint,tests,browser}.log. Artifacts can expire; the committed runner and commands are the reproduction path.

## Ledger and boundary

Baseline v1: **R01 closed; R02–R12 open (11 remaining); added0.** Review script guards, manifest/history assertions, failure boundary and cleanup. Next observable result is R02's exact target/consumer/recovery qualification, not a database mutation. Existing image does not require rebuild for this verification-only script.

Accepted packages5/60 (8.3%); walkthrough3/8 (37.5%); P06 not accepted. ETA remains unvalidated. No migration/deployment/IAM/secrets/charges/provider/customer action authorized or performed. No scope deviation.
