# Split customer/operator review request — review

One owner-approved inactive submit/read section after backend 1e145d1. No production route, operator job admission, UI, provider or sending activation.

## Files and behavior

- customer-intake-continuation.service.ts adds submitReview and readReview. Customer submission requires exact sessionToken/requestId/expectedRevision/draft/confirmed:true; current protected ongoing/unlinked history and expiry are checked under locks.
- One protected_intake_review_v1 event/content and CUSTOMER audit commit atomically. Encrypted draft, scope ID, original expiry and transcript revision/digest are stored; bearer credentials and plaintext contact fields are absent.
- One request per conversation. Exact replay is idempotent; changed/replacement/second requests refuse. Operator read accepts only requestId plus verified owner/admin/dispatcher context, tenant-scopes lookup and rechecks current history/expiry. It never calls credential methods or creates/reconstructs a customer bearer.
- Shared lock takes a scope-only type (no invented token claims); runtime lock behavior is unchanged. Operator result omits session/conversation IDs and is private, human-review-only with no job/booking/delivery authority.
- New service tests add 21 cases. scripts/verify-customer-intake-review-request.mjs hooks into the parent fixture with ten PostgreSQL check groups. No schema/package/module/controller/UI changes.
- summary.json and validation-summary.json record evidence. The operator proof injects a credential proxy that throws on every property access, proving the read does not rely on a customer token.

## Repeat validation

Backend: npm run -s lint; npm test -- --runInBand; npm run -s arch:check; npm run -s build; npx prisma validate.
UI: npm run -s lint; npm test; npm run -s build.
Both roots: npm audit --json; npm audit --omit=dev --json.
HTTP tests require local listener permission; the initial sandbox-only run failed EPERM, then the approved listener-enabled run passed.

After both builds, from the focused backend:

```sh
PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
MESSAGING_SETTINGS_EVIDENCE_DIR=/private/tmp/signmons-review-sms \
TECHNICIAN_INBOX_EVIDENCE_DIR=/private/tmp/signmons-review-inbox \
EMAIL_CAPTURE_EVIDENCE_DIR=/private/tmp/signmons-review-capture \
EMAIL_RECIPIENT_EVIDENCE_DIR=/private/tmp/signmons-review-recipient \
EMAIL_SETTINGS_EVIDENCE_DIR=/private/tmp/signmons-review-settings \
EMAIL_INTENT_EVIDENCE_DIR=/private/tmp/signmons-review-initial \
EMAIL_CHANGE_EVIDENCE_DIR=/private/tmp/signmons-review-changes \
EMAIL_ELIGIBILITY_EVIDENCE_DIR=/private/tmp/signmons-review-eligibility \
EMAIL_CONSENT_EVIDENCE_DIR=/private/tmp/signmons-review-prior-consent \
CUSTOMER_CONSENT_EVIDENCE_DIR=/private/tmp/signmons-review-prior-session \
PROTECTED_INTAKE_EVIDENCE_DIR=/private/tmp/signmons-review-prior-intake \
CUSTOMER_BROWSER_EVIDENCE_DIR=/private/tmp/signmons-review-prior-browser \
CUSTOMER_INTAKE_EVIDENCE_DIR=/private/tmp/signmons-review-prior-continuation \
CUSTOMER_INTAKE_BROWSER_EVIDENCE_DIR=/private/tmp/signmons-review-prior-intake-browser \
CUSTOMER_INTAKE_JOURNEY_EVIDENCE_DIR=/private/tmp/signmons-review-prior-journey \
CUSTOMER_INTAKE_ADMISSION_EVIDENCE_DIR=/private/tmp/signmons-review-prior-admission \
node scripts/verify-sms-enqueue-intents.mjs

psql -h /tmp -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'calldesk_app013_intents_%'"
```

The parent creates/migrates/drops only a random Unix-socket calldesk_app013_intents_<12 hex> database, using the existing nineteen migrations. Local PostgreSQL/listener permission is required. Cleanup query must return no rows. CUSTOMER_INTAKE_REVIEW_EVIDENCE_DIR optionally redirects this new summary; prior evidence outputs are redirected above. A fixture-only binding sort-key typo was corrected; both failed and successful runs cleaned up.

Governance: node --test scripts/execution-placement.test.mjs; node scripts/docs-consistency-check.mjs. Both repositories: git diff --check. New script: node --check and prettier --check.

## Remaining limits

This is durable submission and private read only, not a durable operator decision or admission. Existing combined admitDraft remains unregistered and unchanged; it is not wired behind readReview. Original session expiry caps the review request, with no renewal or new approval SLA. Changed transcript, closed/deleted scope, expiry, foreign tenant or malformed record refuses. No replacement/withdrawal/per-request revocation/recovery or retention implementation; application serialization is not a new database immutability constraint.

No new browser surface or process-crash test; prior desktop/mobile and nineteen process-crash regressions were rerun. Production operator identity/transport/private access auditing, token-free atomic admission, request lifecycle, Calendar/pre-finalization, verification/retention/delivery and old-writer compatibility remain open.

Next proposed: token-free operator admission from the durable request, exact human decision and atomic request/job/consent outcome; preserve deadline/stale/replay rules and keep external actions disabled. UI/route integration follows review. APP-013 stays Now; coverage 50%, formal acceptance 0/12; 7-12 unequal APP-013 / 20-35 pilot remaining sections, low confidence, not an overall MVP percentage or ETA.
