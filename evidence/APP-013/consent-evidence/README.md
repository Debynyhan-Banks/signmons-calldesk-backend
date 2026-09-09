# APP-013 inactive consent evidence — review

Scope: evidence persistence and one-time intake/job binding only. No customer authority, collection UI, production fingerprint key adapter, verification, event grant binding, expiry enforcement, credentials, queue admission or sending.

Review incremental PR #21 after backend 9597ef1. Relevant files:

- src/communications/appointment-email-consent-evidence.ts and .spec.ts
- prisma/schema.prisma and migrations/20260909210000_add_appointment_email_consent_evidence/migration.sql
- scripts/verify-appointment-email-consent.mjs and the existing verify-sms-enqueue-intents.mjs hook
- EXECUTION_BOARD.md, readiness-report.md and this directory

Run from the focused backend worktree:

```sh
npm run -s lint
npm test -- --runInBand
npm run -s arch:check
npm run -s build
npx prisma validate
npm audit --json
npm audit --omit=dev --json
```

The following command creates and drops a random local Unix-socket database, applies all migrations there, runs synthetic persistence/crash checks and local browser/API/database regression checks. It does not use DATABASE_URL or a production service. All old evidence is kept separate:

```sh
PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
MESSAGING_SETTINGS_EVIDENCE_DIR=/private/tmp/signmons-consent-sms \
TECHNICIAN_INBOX_EVIDENCE_DIR=/private/tmp/signmons-consent-inbox \
EMAIL_CAPTURE_EVIDENCE_DIR=/private/tmp/signmons-consent-capture \
EMAIL_RECIPIENT_EVIDENCE_DIR=/private/tmp/signmons-consent-recipient \
EMAIL_SETTINGS_EVIDENCE_DIR=/private/tmp/signmons-consent-settings \
EMAIL_INTENT_EVIDENCE_DIR=/private/tmp/signmons-consent-initial \
EMAIL_CHANGE_EVIDENCE_DIR=/private/tmp/signmons-consent-changes \
EMAIL_ELIGIBILITY_EVIDENCE_DIR=/private/tmp/signmons-consent-eligibility \
node scripts/verify-sms-enqueue-intents.mjs

psql -h /tmp -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'calldesk_app013_intents_%'"
```

Cleanup query must return no rows. New consent results are database-summary.json; the surrounding suite exercises 19 existing crash cases but this section adds rollback/replay/concurrency proof, not new process-crash cases.

From ui/, run lint, tests and build; both full and production-only npm audits. UI has no changes. Local browser results are captured in browser-summary.json; mobile screenshot inspected at /private/tmp/signmons-consent-settings/settings-390.png.

Composition regression:

```sh
PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
EMAIL_COMPOSITION_EVIDENCE_DIR=/private/tmp/signmons-consent-composition \
node scripts/verify-appointment-email-preview.mjs
```

Governance: node --test scripts/execution-placement.test.mjs and node scripts/docs-consistency-check.mjs. Both repositories: git diff --check.

## Remaining authority and retention gates

A synthetic CUSTOMER audit does not prove a remote customer identity. Do not register/call this store from an API until the protected session/displayed-mailbox/prompt/response boundary is implemented and reviewed. No production fingerprint adapter is supplied. Its key lifecycle needs explicit security review; the fictional fixture key is not deployable.

Three immutable models store evidence, not send permission. Latest ledger revision supplies the versioned projection. RESTRICT references protect proof from independent conversation/job/audit deletion but require retention/tenant-deletion ordering review before activation. The approved 90-day rule is not a purge implementation.

Existing event snapshots stay unchanged, with no grant reference. D2 verification, D3 expiry, D4 lifecycle enforcement, customer/operator suppression, future event-time grant binding and durable delivery still require separate sections. No merge, deployment, production migration or provider action is authorized.
