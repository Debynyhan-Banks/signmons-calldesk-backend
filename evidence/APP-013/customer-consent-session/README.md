# Local customer consent session — review

This section implements and tests an inactive credential model, fresh-session bootstrap and exact mailbox/prompt-bound response persistence. It has no production route, DI registration, live key/environment loader, active collection or sending.

Review PR #21 incremental after a39a230. Files: src/communications/customer-consent-credentials.ts, customer-consent-response.service.ts, their .spec.ts files, scripts/verify-customer-consent-session.mjs, the existing verification hook, evidence and execution board. No Prisma migration/schema, package, production UI/controller/module or configuration changes.

## Validation

From the focused backend:

```sh
npm run -s lint
npm test -- --runInBand
npm run -s arch:check
npm run -s build
npx prisma validate
npm audit --json
npm audit --omit=dev --json
```

From ui/: npm run -s lint, npm test, npm run -s build, and both full/production-only npm audits.

Local fixture command (creates/applies migrations/drops only its random Unix-socket database; never uses DATABASE_URL):

```sh
PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
MESSAGING_SETTINGS_EVIDENCE_DIR=/private/tmp/signmons-session-sms \
TECHNICIAN_INBOX_EVIDENCE_DIR=/private/tmp/signmons-session-inbox \
EMAIL_CAPTURE_EVIDENCE_DIR=/private/tmp/signmons-session-capture \
EMAIL_RECIPIENT_EVIDENCE_DIR=/private/tmp/signmons-session-recipient \
EMAIL_SETTINGS_EVIDENCE_DIR=/private/tmp/signmons-session-settings \
EMAIL_INTENT_EVIDENCE_DIR=/private/tmp/signmons-session-initial \
EMAIL_CHANGE_EVIDENCE_DIR=/private/tmp/signmons-session-changes \
EMAIL_ELIGIBILITY_EVIDENCE_DIR=/private/tmp/signmons-session-eligibility \
EMAIL_CONSENT_EVIDENCE_DIR=/private/tmp/signmons-session-prior-consent \
node scripts/verify-sms-enqueue-intents.mjs

psql -h /tmp -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'calldesk_app013_intents_%'"
```

Cleanup query must return no rows. New evidence: database-summary.json, validation-summary.json, prompt-1440.png and prompt-390.png. The new browser fixture is fictional localhost UI through the actual model/evidence/database; it is not a production customer route or transport acceptance. Integration guard verification uses a fictional credential; browser fixture bootstrap is server-owned. No real customer or provider is contacted.

Governance: node --test scripts/execution-placement.test.mjs; node scripts/docs-consistency-check.mjs. Both repositories: git diff --check. Read governance APP013_CUSTOMER_SESSION_SECURITY_PLAN.md.

## Security review

- Separate 15-minute session and at-most-5-minute prompt credentials. No sliding renewal. Exact expiry, wrong purpose/key/session and modified claims refuse.
- Fresh bootstrap never adopts an arbitrary prior session. Possession is session authority, not civil identity or mailbox verification.
- Prompt binds current randomized ciphertext and exact approved text. GRANTED additionally requires boolean mailboxConfirmed:true; DECLINED can proceed without confirming the address.
- Response and evidence persist atomically. Replays return one historical receipt only; conflicting/replaced/expired prompts cannot grant. Expiry after persistence rolls back all writes. Completed decisions are not re-asked.
- No production signing-key loader, mailbox fingerprint adapter, customer transport, cookie/CSRF/abuse controls, legacy triage retrofit, lost/expired-session recovery or revocation UI. These remain review/implementation gates.
- D2 verification, D3 event expiry, D4 lifecycle/retention enforcement, event-time grant reference, management credentials and queue admission remain unconnected. Sending is disabled.
- Existing 19-migration/19-crash-case regression runs again; no new migration or customer-session process-crash case. Fresh service restart/replay, transaction rollback, race and expiry-boundary behavior are tested.
