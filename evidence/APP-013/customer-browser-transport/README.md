# Inactive customer browser boundary — review

One owner-approved local browser-security section, from backend 18cd9a9. No production controller/module/configuration, schema/package, UI deployment, key/provider configuration, collection or sending is activated.

Files: src/communications/customer-consent-browser-transport.ts and customer-consent-browser-budget.ts plus their tests; scripts/verify-customer-browser-transport.mjs and the prior session-proof hook; scripts/fixtures/customer-browser-transport.html/.js; evidence and governance.

## Review the behavior

1. The fixed server origin/tenant binding requires verified integration context, TLS (except explicit loopback fixture), same-origin Origin/Host/Fetch Metadata and a custom JSON request header. Cookies/public integration Authorization, cross-origin/same-site/missing/null values, query credentials and malformed paths refuse.
2. Non-start requests verify the separate customer-session credential tenant before reaching existing protected capture/prompt/response services. Browser headers alone are not customer authentication.
3. Headers and streamed/final bodies are bounded; UTF-8 and compact exact-field JSON are strict. Missing/broken budget refuses. The local budget has fixed-window/per-peer/global/start/concurrency limits, but resets on restart and is not a distributed production limiter.
4. Responses are private/no-store, no-referrer/nosniff, without CORS authorization or cookies. Explicit projections omit internal evidence IDs. Errors/diagnostics never echo request content, URLs, credentials, mailboxes or raw failures. No automatic retry.
5. Inspect summary.json and private-prompt-390.png. Fictional browser flow covers bootstrap/capture/prompt/grant or decline against real local services/database; a second local origin attempts both simple POST and JSON preflight. Prior model screenshots remain historical.

## Repeat validation

Backend: npm run -s lint; npm test -- --runInBand; npm run -s arch:check; npm run -s build; npx prisma validate. UI: npm run -s lint; npm test; npm run -s build. Both package roots: npm audit --json; npm audit --omit=dev --json.

After both builds, from the focused backend:

```sh
PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
MESSAGING_SETTINGS_EVIDENCE_DIR=/private/tmp/signmons-browser-sms \
TECHNICIAN_INBOX_EVIDENCE_DIR=/private/tmp/signmons-browser-inbox \
EMAIL_CAPTURE_EVIDENCE_DIR=/private/tmp/signmons-browser-capture \
EMAIL_RECIPIENT_EVIDENCE_DIR=/private/tmp/signmons-browser-recipient \
EMAIL_SETTINGS_EVIDENCE_DIR=/private/tmp/signmons-browser-settings \
EMAIL_INTENT_EVIDENCE_DIR=/private/tmp/signmons-browser-initial \
EMAIL_CHANGE_EVIDENCE_DIR=/private/tmp/signmons-browser-changes \
EMAIL_ELIGIBILITY_EVIDENCE_DIR=/private/tmp/signmons-browser-eligibility \
EMAIL_CONSENT_EVIDENCE_DIR=/private/tmp/signmons-browser-prior-consent \
CUSTOMER_CONSENT_EVIDENCE_DIR=/private/tmp/signmons-browser-prior-session \
PROTECTED_INTAKE_EVIDENCE_DIR=/private/tmp/signmons-browser-prior-intake \
node scripts/verify-sms-enqueue-intents.mjs

psql -h /tmp -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'calldesk_app013_intents_%'"
```

Only the parent's random Unix-socket PostgreSQL database is created/migrated/dropped; DATABASE_URL is not used. Cleanup query must return no rows. CUSTOMER_BROWSER_EVIDENCE_DIR redirects the new proof. No real customers, live keys or provider calls.

Governance: node --test scripts/execution-placement.test.mjs; node scripts/docs-consistency-check.mjs. Both repos: git diff --check.

## Remaining limits

Read governance APP013_CUSTOMER_BROWSER_TRANSPORT.md and APP013_CUSTOMER_SESSION_SECURITY_PLAN.md. Production BFF/TLS/proxy/access-log/parser-error handling, server secret loading, distributed abuse protection and full credential-bound AI intake are not implemented by this local model. Mailbox verification/fingerprint lifecycle, retention, event-time consent/expiry/admission/delivery, old-writer compatibility and existing Calendar/pre-finalization release risks remain.

The fixture uses mode:cors with fixed same-origin URLs and no-referrer; no cross-origin permission is granted. Strict browser metadata follows [OWASP guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) and the [W3C wire format](https://www.w3.org/TR/fetch-metadata/#sec-fetch-dest-header). Initial browser QA found and corrected the empty-string versus literal empty destination mismatch; the final bootstrap success assertion and hostile-origin tests must both pass.
