# Integrated protected intake journey — review

One owner-approved local section after backend b5a089f. No production route/UI/key/configuration, AI, job creation, Calendar/payment/provider action or sending activation.

## Changed files and behavior

- src/communications/customer-intake-draft.ts: exact seven-field customer-stated draft validation. Name/address/description are bounded, phone uses international +digits format, categories use the existing intake vocabulary. Unknown fields, urgency/authority overrides and malformed values refuse.
- customer-intake-continuation.service.ts: read-only previewDraft reuses protected ongoing/unlinked session/history locks, checks expected transcript revision, and reads historical email choice. It creates no records and is not a CreateJobPayload, saved draft or admission receipt.
- customer-consent-browser-transport.ts and budget: sixth inactive model operation /customer-session/draft, exact input and explicit private non-authorizing result. Missing adapter refuses.
- Service/transport tests add 28 cases. No production registration/schema/package changes.
- scripts/fixtures/customer-intake-journey.html/.js: one scripted conversation turn, optional capture/permission and manually reviewed draft. Description carries forward. Skip and decline do not block progress; no urgency decision is invented.
- scripts/verify-customer-intake-journey.mjs and session hook: actual browser/HTTP/services/database grant, decline and skip branches. Capture/respond post-commit 503 retries reuse exact input and record once; read-only draft snapshots prove no extra writes.
- Evidence: summary.json, validation-summary.json and draft-GRANTED-1440.png, draft-DECLINED-390.png, draft-NOT_RECORDED-390.png. Mobile declined preview visually inspected.

## Repeat validation

Backend: npm run -s lint; npm test -- --runInBand; npm run -s arch:check; npm run -s build; npx prisma validate.
UI: npm run -s lint; npm test; npm run -s build.
Both roots: npm audit --json; npm audit --omit=dev --json.

After both builds, run from the focused backend:

```sh
PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
MESSAGING_SETTINGS_EVIDENCE_DIR=/private/tmp/signmons-journey-sms \
TECHNICIAN_INBOX_EVIDENCE_DIR=/private/tmp/signmons-journey-inbox \
EMAIL_CAPTURE_EVIDENCE_DIR=/private/tmp/signmons-journey-capture \
EMAIL_RECIPIENT_EVIDENCE_DIR=/private/tmp/signmons-journey-recipient \
EMAIL_SETTINGS_EVIDENCE_DIR=/private/tmp/signmons-journey-settings \
EMAIL_INTENT_EVIDENCE_DIR=/private/tmp/signmons-journey-initial \
EMAIL_CHANGE_EVIDENCE_DIR=/private/tmp/signmons-journey-changes \
EMAIL_ELIGIBILITY_EVIDENCE_DIR=/private/tmp/signmons-journey-eligibility \
EMAIL_CONSENT_EVIDENCE_DIR=/private/tmp/signmons-journey-prior-consent \
CUSTOMER_CONSENT_EVIDENCE_DIR=/private/tmp/signmons-journey-prior-session \
PROTECTED_INTAKE_EVIDENCE_DIR=/private/tmp/signmons-journey-prior-intake \
CUSTOMER_BROWSER_EVIDENCE_DIR=/private/tmp/signmons-journey-prior-browser \
CUSTOMER_INTAKE_EVIDENCE_DIR=/private/tmp/signmons-journey-prior-continuation \
CUSTOMER_INTAKE_BROWSER_EVIDENCE_DIR=/private/tmp/signmons-journey-prior-intake-browser \
node scripts/verify-sms-enqueue-intents.mjs

psql -h /tmp -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'calldesk_app013_intents_%'"
```

Only the parent's random local Unix-socket PostgreSQL database is migrated and dropped with the existing nineteen migrations. Cleanup query must return no rows. CUSTOMER_INTAKE_JOURNEY_EVIDENCE_DIR can redirect new proof. Prior evidence output is redirected, not overwritten.

Governance: node --test scripts/execution-placement.test.mjs; node scripts/docs-consistency-check.mjs. Both repos: git diff --check. Changed scripts: node --check and prettier --check.

## Limits

Draft is format-validated customer input, not verified identity/contact/address, extracted AI facts or an urgency assessment. UI review checkbox is not server admission authority. Draft is not persisted; expected transcript revision binds the read only, and returned snapshots can become stale. Email choice is historical, never sending authority. Skip creates no capture/evidence; current capture and consent steps are individually durable, not one all-or-nothing transaction. Clear/expiry/reload loses local recovery authority without undoing prior writes.

No actual AI/urgency/job handoff, production key/transport/distributed limiter, retention, mailbox verification, expiry/admission/delivery, Calendar/pre-finalization or old-writer release compatibility is completed here. Existing nineteen child-process crash cases are regression coverage; no new crash case.

Next proposed after review: local atomic intake-to-job handoff with human review and session/job/consent binding, after reviewing admission/urgency requirements; Calendar/payment/provider and sending remain disabled. APP-013 stays Now. Completion remains 50% scope coverage, 0/12 formal acceptance; 7-12 unequal APP-013 / 20-35 pilot remaining sections, low confidence, not overall MVP completion or ETA.
