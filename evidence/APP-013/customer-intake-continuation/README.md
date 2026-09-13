# Inactive credential-bound intake continuation — review

One owner-approved bounded section after backend 43108f1. No production AI, browser dispatch, booking, collection or sending activation.

## Review behavior

- New service/tests: src/communications/customer-intake-continuation.service.ts and .spec.ts. Shared lock additionally selects conversation status. Verification script is invoked by the existing customer-session fixture.
- An exact unexpired session credential owns the protected conversation. Only ongoing conversations without job links are eligible. Caller-supplied history, tenant, reply and raw session IDs refuse.
- New encrypted input/reply pairs use protected_intake_turn_v1, strict shape and sequential revisions, with no plaintext fallback. Legacy messages are excluded; legacy readers cannot display protected pairs.
- Scripted reply runs outside database locks. Ownership and history are rechecked before atomic event/content/audit persistence. Changed concurrent history refuses rather than silently recomputing.
- Retry only the same interaction ID and same message with the same unexpired session after an uncertain outcome. Exact committed replay does not call a collaborator or append. Changed input/foreign event collision refuses. Twenty-turn and 2000-character limits are deliberately bounded.
- Read summary.json for twelve real database checks and validation-summary.json for gate totals. Concurrent same-ID computations can both run, but only one pair persists. No live provider exactly-once guarantee or new child-process crash coverage.

## Repeat validation

Backend: npm run -s lint; npm test -- --runInBand; npm run -s arch:check; npm run -s build; npx prisma validate.
UI: npm run -s lint; npm test; npm run -s build.
Both roots: npm audit --json; npm audit --omit=dev --json.

After both builds, run from the focused backend:

```sh
PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
MESSAGING_SETTINGS_EVIDENCE_DIR=/private/tmp/signmons-continuation-sms \
TECHNICIAN_INBOX_EVIDENCE_DIR=/private/tmp/signmons-continuation-inbox \
EMAIL_CAPTURE_EVIDENCE_DIR=/private/tmp/signmons-continuation-capture \
EMAIL_RECIPIENT_EVIDENCE_DIR=/private/tmp/signmons-continuation-recipient \
EMAIL_SETTINGS_EVIDENCE_DIR=/private/tmp/signmons-continuation-settings \
EMAIL_INTENT_EVIDENCE_DIR=/private/tmp/signmons-continuation-initial \
EMAIL_CHANGE_EVIDENCE_DIR=/private/tmp/signmons-continuation-changes \
EMAIL_ELIGIBILITY_EVIDENCE_DIR=/private/tmp/signmons-continuation-eligibility \
EMAIL_CONSENT_EVIDENCE_DIR=/private/tmp/signmons-continuation-prior-consent \
CUSTOMER_CONSENT_EVIDENCE_DIR=/private/tmp/signmons-continuation-prior-session \
PROTECTED_INTAKE_EVIDENCE_DIR=/private/tmp/signmons-continuation-prior-intake \
CUSTOMER_BROWSER_EVIDENCE_DIR=/private/tmp/signmons-continuation-prior-browser \
node scripts/verify-sms-enqueue-intents.mjs

psql -h /tmp -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'calldesk_app013_intents_%'"
```

Only the parent's random local Unix-socket database is migrated/dropped, using the existing nineteen migrations. Cleanup query must return no rows. CUSTOMER_INTAKE_EVIDENCE_DIR optionally redirects this new summary. Existing browser proofs are regressions; this new service has no browser operation/UI yet.

Governance: node --test scripts/execution-placement.test.mjs; node scripts/docs-consistency-check.mjs. Both repos: git diff --check.

## Remaining limits

Application locks/history digest are not immutable database transcript constraints or retention integration. Session expiration has no recovery/renewal authority. Scripted callback has no production AI/tool adapter or deadline/abort policy. Before such an adapter, review privacy, bounded execution, cancellation, tool authority and output handling. Production BFF/TLS/proxy/access logs/distributed rate limits/key lifecycle, full AI/booking, verification/retention/admission/delivery and existing Calendar/pre-finalization compatibility remain gated.

Next proposed after review: local authenticated browser binding with same-interaction retry and stale/expired-session UX, still scripted-only. APP-013 stays Now. Coverage remains 50%, formal acceptance 0/12; 7-12 unequal APP-013 / 20-35 pilot sections, low confidence, not an overall completion percentage or ETA.
