# APP-013 P2: shared consent/suppression write boundary

Review-ready bounded P2 section, 2026-09-12. P2 is **not complete**. The current checkpoint follows P1 backend 5e771c3 and owner approval to proceed.

## Implemented

- Shared transaction-scoped tenant/recipient advisory lock, including recipients with no consent row. Acquire before customer/session/policy locks. Existing HMAC key/input bytes unchanged; no key rotation.
- START checks prior opt-out inside the same transaction as its update, customer flag and privacy-safe audit. Concurrent START requests cannot both restore the same opt-out.
- Legacy verbal grants cannot overwrite an existing opt-out; they return conflict. Initial verbal grants retain existing compatibility. STOP and explicit declines still suppress. No claim that legacy grants satisfy the future policy-bound capture contract.
- Additive local migration adds positive SmsConsentRecord.revision; a database trigger increments on every update, including repeated STOP/change-back and attempts to reset revision. Overflow fails closed. Future capture must snapshot/revalidate it under the same lock.
- No controller, registry/capture bridge, fixture promotion, provider configuration, queue creation or live activation added.

Files: src/communications/sms-consent-recipient.ts, sms-consent.service.ts and their specs; prisma/schema.prisma; prisma/migrations/20260912170000_sms_consent_revision/migration.sql; scripts/verify-sms-consent-serialization.mjs and its existing disposable-runner integration; EXECUTION_BOARD.md and this evidence directory.

## Validation

- Build, lint, architecture and whitespace checks passed. Production dependency audit: zero vulnerabilities.
- Full Jest: 103 suites / 1,945 tests passed; one suite / three existing tests skipped.
- Existing 20 durable intake/registry regression groups passed. Browser fixture exercised at 390px/1280px with keyboard choice, lost-response replay, skip and no overflow. Screenshots are existing fictional intake regression evidence, **not new policy-bound capture UI**. Mobile saved and desktop prompt screenshots visually inspected.
- Seven new PostgreSQL suppression groups passed: missing-consent queue refusal; stale verbal grant after STOP; concurrent START; overlapping STOP/stale capture; atomic rollback including audit/customer/revision; unknown STOP commit/reconstruction/retry and database revision fencing; tenant separation and existing delivery-consumer suppression.
- New proof deliberately uses two fictional legacy consent rows in the disposable database (including transient local opt-ins for compatibility tests). Final opt-in count zero; zero provider calls, delivery events and production writes. Base summary.json is the pre-suppression regression snapshot; suppression/summary.json describes the subsequent integration phase.
- Three development harness runs failed before the final pass: missing fictional staging environment, Prisma refusing the lock query's void result (fixed by projecting text), then incorrect processQueue harness method (corrected to processDue). Every run removed its own disposable database. No failed result is treated as passing evidence.

## Exact review / reproduction

1. Inspect service diff: lock precedes consent reads/customer writes; START's check is inside the transaction; verbal opt-in after opt-out fails before any write.
2. Inspect SQL trigger and suppression/summary.json. Verify this does not grant new capture/send authority or change configured keys.
3. Run npm run -s build, npm run -s lint, npm run -s arch:check, npm test -- --runInBand, npm audit --omit=dev --audit-level=high, git diff --check.
4. With local Unix-socket PostgreSQL available, run the command below. It creates and drops only its own randomly named local database and never uses production DATABASE_URL:

```sh
PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs SMS_INTAKE_EVIDENCE_DIR=/private/tmp/signmons-app013-messaging.R4Ep40/evidence/APP-013/sms-consent-serialization node scripts/verify-durable-fixture-sms-consent.mjs
```

## Remaining / release boundaries

Next P2 section: define and implement the production-shaped policy-bound capture evidence relation using the registry reader and shared recipient lock/revision, with capture/send release gates disabled. Reuse existing encryption/deadline/session/audit/recovery proof; do not promote fixture tables. It must prove combined policy/session/phone/revocation revalidation and exact capture retry. Legacy keyword retries remain suppressive but are not audit-deduplicated; provider event identity/order qualification remains open. A later explicit START can restore service by existing behavior, so this is not a global event-time ordering guarantee.

Retention/key lifecycle, real publication evidence, provider activation, production migration and release remain separately gated. No merge, deployment, public-policy publication, real customer data or account/billing changes. Saved checkout changes preserved.

APP-013 sole Now; current steel-thread 2B; accepted 3/8 = 37.5% of fixed milestones, unchanged. Five milestone acceptances remain; no defensible overall MVP engineering percentage or calendar ETA added. This is part of P2, not a new milestone.
