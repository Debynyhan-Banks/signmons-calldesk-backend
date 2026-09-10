# Local reviewed intake admission — review

One bounded APP-013 section after backend `0a2b7ab`. The new admission path is an unregistered local service only. It does not add a controller, module provider, browser route, production credential, migration, package, Calendar/payment call, notification, provider request or send.

## Behavior

- `CustomerIntakeContinuationService.admitDraft` requires the exact protected-session credential and transcript revision plus a verified non-impersonated owner/admin/dispatcher request context.
- The review decision is exact: one of `EMERGENCY`, `HIGH` or `STANDARD`, fixed reason `OPERATOR_REVIEWED_INTAKE`, and an explicit acknowledgment that the fields are customer statements. No caller tenant, actor, job, consent, booking, payment or delivery override is accepted.
- Under the shared tenant/session/conversation lock, the service rechecks ongoing/unlinked history, requires the selected category to exist in the tenant catalog, then creates/updates the customer, creates the customer-stated address and CREATED job, records the CREATED_FROM link, binds any existing immutable email-consent history, writes a privacy-safe human-review audit and closes the conversation in one transaction.
- The job policy records a one-way exact-request digest, transcript revision, human-review decision and explicit unverified contact/address state. Name, phone and address are absent from the audit and policy binding. The ordinary job/customer/address records retain the reviewed statements for operator intake review.
- Exact same-actor/request replay with the same unexpired session returns the prior receipt. Changed review/draft cannot adopt it. Concurrent identical requests serialize to one job/link/audit.
- Closing the session blocks later transcript, email capture and consent prompts. Binding failure or session-close conflict rolls back the job, link, audit, binding and close together.

## Local proof

Build first, then run the parent disposable-database verifier. Redirect the pre-existing browser evidence outputs to a temporary directory as documented in the top-level APP-013 readiness report; leave `CUSTOMER_INTAKE_ADMISSION_EVIDENCE_DIR` unset to refresh `summary.json` here.

```sh
npm run -s build
PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
node scripts/verify-sms-enqueue-intents.mjs
psql -h /tmp -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'calldesk_app013_intents_%'"
```

The parent creates a random `calldesk_app013_intents_<12 hex>` database on the local Unix socket, applies the existing nineteen migrations, runs the real Prisma/services and drops the database in `finally`. The cleanup query must return no rows. The proof uses fictional data and signing/fingerprint keys; provider calls are zero.

## Limits

- Customer name, phone and address are reviewed statements, not verified identity/contact/address or geocoding evidence. Human urgency is an operator classification, not a diagnosis.
- No preferred window is supplied, so the new CREATED job remains subject to existing intake-readiness, payment, availability, booking and dispatch review.
- This is not a production dual-credential transport design. The local invocation has both protected customer-session and verified operator context; no public/operator endpoint or customer-browser admission action exists.
- Email choice is historical association only. `BOUND` never means current permission, delivery eligibility or sending authority; `NOT_RECORDED` is allowed.
- Replay is only for the exact request while the same customer credential remains valid and the job is still the original CREATED admission. Later lifecycle changes require ordinary operator reads, not this receipt.
- No APP-013 acceptance criterion is signed off by local proof. Production identity/session lifecycle, retention, policy/verification, preferred-window/payment/Calendar handoff, email delivery/status/recovery and owner acceptance remain open.
