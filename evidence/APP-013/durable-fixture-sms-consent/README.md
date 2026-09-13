# APP-013 durable fixture SMS evidence — 2026-09-12

Owner reviewed 852e766 and approved the next bounded section. Local implementation is review-ready; APP-013 is not complete or released.

## Outcome

The existing intake SMS port can now await encrypted PostgreSQL-backed fixture evidence instead of losing it on service restart. Tenant/conversation/session scope, original credential identity, displayed disclosure/version, phone revision, actual customer phone/update timestamp and original deadline bind the prompt. Current encrypted fictional policy and recipient are read while session/customer/policy locks are held. Every policy-row update increments a database revision, so change-then-restore cannot revive old prompts.

First capture and its privacy-safe audit commit atomically. Exact retry returns the original timestamp without another audit; changed, missing, expired, closed, opted-out or corrupt inputs refuse even a historical receipt. A final database-clock check rolls back capture if the deadline passes during the write. Decline leaves suppression and capture evidence unchanged; browser skip sends no capture request.

FixtureSmsConsentState and FixtureSmsConsentPrompt are separate from SmsConsentRecord and Customer.consentToText. All receipts remain fixtureOnly=true, liveConsentRecorded=false, deliveryAuthorized=false; the durable adapter adds storage=DURABLE_FIXTURE. No provider or production registration exists. The UI explicitly says local fixture database, not live permission.

## Changed files

- src/communications/durable-fixture-sms-consent.ts and its spec: inactive transaction adapter and boundary tests.
- src/communications/fixture-sms-policy.ts and fixture-sms-consent.ts: shared validation and preserved memory-only regression path.
- src/communications/customer-consent-browser-transport.ts: await optional fixture port; existing authentication/origin/budget checks retained.
- prisma/schema.prisma and migrations/20260912150000_fixture_sms_consent_evidence/migration.sql: encrypted fixture tables, composite foreign keys, time/audit constraints and policy revision trigger.
- scripts/fixtures/customer-intake-journey.html/.js: truthful saved-test status and grouped checkbox layout.
- scripts/verify-durable-fixture-sms-consent.mjs and verify-fixture-sms-consent.mjs: disposable database/recovery and reusable mobile/desktop browser evidence.

## Validation

- Build, lint, architecture and whitespace checks passed.
- Jest: 101 suites / 1,917 tests passed; one suite / three tests skipped.
- Production dependency audit: zero vulnerabilities.
- Disposable PostgreSQL: 14 check groups passed; five captured rows and five matching audits, zero live consent rows, customer consent grants, delivery events or provider calls.
- Browser: 390px/1280px real durable model + protected transport; unchecked initial choice, keyboard toggle, no horizontal overflow, lost-response retry and continuation without SMS passed. Non-SMS intake responses are mocked, not an end-to-end live intake demonstration.
- Prior memory-only and default unavailable-policy branches passed at both widths. Screenshots visually reviewed.

All migrations were applied only to a randomly named, newly created Unix-socket local database. It was removed after validation; no real records were removed. Service/client reconstruction demonstrates stored receipt recovery, not PostgreSQL process restart or production backup/restore certification.

## Exact review and reproduction

1. Compare browser/fixture-sms-390.png with browser/fixture-sms-saved-390.png (desktop equivalents are 1280). Confirm unchecked choice, fictional policy, saved-local-test wording and no live permission.
2. Read summary.json for refusal/recovery checks and equal capture/audit counts; browser/summary.json identifies the mocked intake boundary.
3. Review transaction locks, current-recipient checks and final deadline recheck in durable-fixture-sms-consent.ts; verify no live consent write or provider import.
4. Run npm run build, npm run lint, npm run arch:check and npm test -- --runInBand. With a local PostgreSQL server on Unix socket /tmp:5432, set PLAYWRIGHT_MODULE to the installed Playwright index.mjs and SMS_INTAKE_EVIDENCE_DIR to an explicit output directory, then run node scripts/verify-durable-fixture-sms-consent.mjs. This runner creates and removes only its own validated random database. Never substitute a production DATABASE_URL.

## Remaining boundaries and progress

The trusted source is persisted fictional configuration, not an implemented production policy approval/publication lifecycle. Local Privacy/Terms paths are fictional. Real policy URLs/versions, recipient/suppression integration, key lifecycle, retention/deletion and release qualification remain required before real enrollment. Fixture records are capped at 256 per session, retained until fixture teardown and never swept into live consent; production retention is not silently selected here.

Next proposed work is the bounded production policy/source and activation-readiness contract review, identifying what remains for the controlled pilot without reopening this proven storage/retry section. No live activation is approved by this checkpoint. APP-013 remains Now; Next empty; FE-014 paused. Steel-thread acceptance stays 3/8 (37.5% milestones), not overall MVP effort. No new milestone, percentage denominator, deployment, merge, provider configuration, billing or production migration.
