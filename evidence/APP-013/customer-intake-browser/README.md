# Local authenticated browser continuation — review

Owner-approved bounded section from backend c3b4b23. No production route, UI deployment, AI/booking, key/configuration, collection or sending activation.

## Files and behavior

- src/communications/customer-consent-browser-transport.ts and its tests: fifth inactive model operation /customer-session/continue; exact credential/interaction/message, inherited same-origin/server-context/tenant/body/budget checks, missing adapter refusal and private receipt projection.
- customer-consent-browser-budget.ts admits continuation under the existing limits. The service remains absent from production DI; its registration test now permits the explicitly inactive browser adapter.
- scripts/fixtures/customer-intake-browser.html and .js: fictional memory-only conversation, immutable pending interaction, explicit same-request retry after uncertain outcomes, expiry/stale guidance and generation-isolated clear/restart.
- scripts/verify-customer-intake-browser.mjs and session fixture hook: actual local HTTP, services and disposable database, with scripted reply only.
- summary.json records nine new desktop/mobile check groups. validation-summary.json records gates. Inspect conversation-390.png and expired-390.png; literal HTML-like reply text is deliberately rendered as text, not markup.

## Repeat validation

Backend: npm run -s lint; npm test -- --runInBand; npm run -s arch:check; npm run -s build; npx prisma validate.
UI: npm run -s lint; npm test; npm run -s build.
Both roots: npm audit --json; npm audit --omit=dev --json.

After both builds, from the focused backend:

```sh
PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
MESSAGING_SETTINGS_EVIDENCE_DIR=/private/tmp/signmons-intake-browser-sms \
TECHNICIAN_INBOX_EVIDENCE_DIR=/private/tmp/signmons-intake-browser-inbox \
EMAIL_CAPTURE_EVIDENCE_DIR=/private/tmp/signmons-intake-browser-capture \
EMAIL_RECIPIENT_EVIDENCE_DIR=/private/tmp/signmons-intake-browser-recipient \
EMAIL_SETTINGS_EVIDENCE_DIR=/private/tmp/signmons-intake-browser-settings \
EMAIL_INTENT_EVIDENCE_DIR=/private/tmp/signmons-intake-browser-initial \
EMAIL_CHANGE_EVIDENCE_DIR=/private/tmp/signmons-intake-browser-changes \
EMAIL_ELIGIBILITY_EVIDENCE_DIR=/private/tmp/signmons-intake-browser-eligibility \
EMAIL_CONSENT_EVIDENCE_DIR=/private/tmp/signmons-intake-browser-prior-consent \
CUSTOMER_CONSENT_EVIDENCE_DIR=/private/tmp/signmons-intake-browser-prior-session \
PROTECTED_INTAKE_EVIDENCE_DIR=/private/tmp/signmons-intake-browser-prior-intake \
CUSTOMER_BROWSER_EVIDENCE_DIR=/private/tmp/signmons-intake-browser-prior-browser \
CUSTOMER_INTAKE_EVIDENCE_DIR=/private/tmp/signmons-intake-browser-prior-continuation \
node scripts/verify-sms-enqueue-intents.mjs

psql -h /tmp -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'calldesk_app013_intents_%'"
```

Only the parent's random Unix-socket PostgreSQL database is migrated/dropped using the existing nineteen migrations. Cleanup query must return no rows. CUSTOMER_INTAKE_BROWSER_EVIDENCE_DIR can redirect this new proof. Both development/final fixture runs cleaned up.

New browser QA uses 1440/390 widths. A gateway 503 is deliberately substituted after a real commit; manual retry returns the saved result with no extra write or scripted callback. An initial socket-reset injection did not reliably expose the retry state, so no network-stack exactly-once guarantee is claimed. A held real request demonstrates that clearing/aborting does not undo persistence but cannot publish its late response into a new session. Server-expiry refusal and separate accelerated client-deadline clearing are both exercised. No new child-process crash tests or production TLS/proxy acceptance.

Governance: node --test scripts/execution-placement.test.mjs; node scripts/docs-consistency-check.mjs. Both repositories: git diff --check.

## Limits and next review

Pending requests retain their original ID/message/unexpired credential only in page memory; reload/expiry/clear loses recovery authority. No session renewal or appointment recovery. Client timeout/abort is not server/provider cancellation, and browser networking can independently retry requests. No distributed limiter, production key loader, full protected AI/booking, retention, mailbox verification, durable admission/delivery or Calendar/pre-finalization compatibility resolution.

Next proposed: one integrated local protected intake journey combining transcript, optional email/consent and a validated job draft, with scripted collaborators and no Calendar/payment/provider activation. APP-013 remains Now. Estimate stays 50% scope coverage, 0/12 acceptance; 7-12 unequal APP-013 / 20-35 pilot sections, low confidence, not overall completion or ETA.
