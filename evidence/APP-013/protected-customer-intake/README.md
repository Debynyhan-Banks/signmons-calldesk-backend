# Protected customer intake isolation — local review

Review PR #21 incremental after abd9b5a. Fresh model sessions are reserved for the protected flow; legacy triage/capture refuse them. New unregistered capture uses customer credentials, same-session locks and atomic encrypted capture/audit. No live customer route, full protected AI intake, collection, verification, sending, migration or key/configuration is enabled.

Files: src/conversations/protected-customer-session.ts and its tests; two existing conversation services; src/communications/customer-consent-session-lock.ts, customer-consent-capture.service.ts/tests and customer-consent-response.service.ts/tests; scripts/verify-protected-customer-intake.mjs, fixtures/protected-customer-intake.html and prior session verification hook.

## Repeat validation

Backend: npm run -s lint; npm test -- --runInBand; npm run -s arch:check; npm run -s build; npx prisma validate. UI: npm run -s lint; npm test; npm run -s build. At both roots: npm audit --json; npm audit --omit=dev --json.

After backend/UI builds, run from the focused backend:

```sh
PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
MESSAGING_SETTINGS_EVIDENCE_DIR=/private/tmp/signmons-protected-sms \
TECHNICIAN_INBOX_EVIDENCE_DIR=/private/tmp/signmons-protected-inbox \
EMAIL_CAPTURE_EVIDENCE_DIR=/private/tmp/signmons-protected-capture \
EMAIL_RECIPIENT_EVIDENCE_DIR=/private/tmp/signmons-protected-recipient \
EMAIL_SETTINGS_EVIDENCE_DIR=/private/tmp/signmons-protected-settings \
EMAIL_INTENT_EVIDENCE_DIR=/private/tmp/signmons-protected-initial \
EMAIL_CHANGE_EVIDENCE_DIR=/private/tmp/signmons-protected-changes \
EMAIL_ELIGIBILITY_EVIDENCE_DIR=/private/tmp/signmons-protected-eligibility \
EMAIL_CONSENT_EVIDENCE_DIR=/private/tmp/signmons-protected-prior-consent \
CUSTOMER_CONSENT_EVIDENCE_DIR=/private/tmp/signmons-protected-prior-session \
node scripts/verify-sms-enqueue-intents.mjs

psql -h /tmp -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'calldesk_app013_intents_%'"
```

Only the random calldesk_app013_intents_ database through the local Unix socket is created/migrated/dropped; DATABASE_URL is not used. Cleanup query must return no rows. PROTECTED_INTAKE_EVIDENCE_DIR can redirect new screenshots/summary outside this committed directory.

Governance: node --test scripts/execution-placement.test.mjs; node scripts/docs-consistency-check.mjs. Both repositories: git diff --check.

## Objective results and limits

- 26 new unit tests; 1331 passing backend tests in 77 passing suites, prior 3 tests/1 suite skipped. UI unchanged: 170 tests and 15-page build. Backend/UI lint/build, architecture, Prisma and four clean dependency audits.
- Ten new database checks listed in database-summary.json, including both real controller methods through AiService refusing before downstream work, same-scope capture concurrency, unchanged replay, rollback after audit persistence and expiry, raw-ID/tenant/session/marker refusal. HTTP guards are not reimplemented or bypass-enabled; controller-method proof is not full production HTTP auth acceptance.
- Existing 19 migrations, 18 session/24 consent checks, 19 process crashes and 23 eligibility reads rerun. No new process crash or migration. Existing local Settings/Inbox and consent prompt browser regressions pass. Unrelated static browser scripts and email composition are not rerun.
- New browser fixture: 1440/390, four GET/ten POST, expiry form clearing, loss on reload, six distinct new scopes, no storage/cookie/external/provider calls. Inspect expired-390.png. The illustrative fixture has no production BFF/HTTPS/origin/CSRF/rate-limit acceptance.
- Server-owned JSON marker is not a database-immutable protection against privileged SQL or old writers. No historical session upgrade/adoption. Unmarked legacy sessions retain their prior behavior; full credential-bound AI intake is unfinished. Retention/deletion, rollout compatibility, dedicated fingerprint keys, verification, event-time binding/expiry/admission and delivery remain gated.

No merge, deployment, production migration, live key/credential/provider configuration, billing or real-customer action. Completion stays 50% APP-013 scope coverage, 0/12 acceptance; 7-12 APP-013 / 20-35 pilot unequal sections, low confidence, not overall MVP percentage or ETA.
