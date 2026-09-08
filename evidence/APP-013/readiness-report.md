# APP-013 Review Checkpoint - Communication Availability Boundaries

Date: 2026-09-08

## Read-only notification center checkpoint (2026-09-08)

- Refreshed both remotes and continued backend `477048a` / governance `f9eb359`. APP-013 remains the sole approved Now ticket; no previous lifecycle work was repeated.
- Added `/app/notifications` (`SCR-APP-021`) and dispatch navigation. The screen consumes only the existing owner/admin/dispatcher SMS history endpoint: latest 100 records with optional UUID job filter, client-side status filters and counts explicitly limited to loaded records.
- Shows template label/version, job/event IDs, direction, timestamp (explicit UTC), attempts, status and bounded failure code. Sent is not labeled delivered. Failed and dead-letter records are grouped for attention; this screen has no send, replay, template-edit or email controls.
- Tokens are password-masked and held only in page memory. Editing token/job or clearing the session removes displayed records and invalidates earlier requests. Raw server errors, message bodies, phone numbers and provider identifiers are not rendered. Server tenant/role guards are unchanged.
- Backend regression gates passed: build/lint, 36 suites / 323 tests (1 suite / 3 existing policy skips), architecture and Prisma validation. UI lint, 5 suites / 23 tests and build (14 static pages) passed. Six new helper tests cover status semantics, filters, template fallback, job validation and time formatting.
- Synthetic Chrome browser QA passed against a local static export: desktop 1440px, mobile 390px without horizontal overflow, job/status filters, invalid UUID, empty/error/loading states, 403 and 500 responses, late response after session clearing, no token storage, omission of injected private fields, keyboard order and no page runtime errors. All five mocked API requests were GETs. This is fixture UI evidence, not live authenticated backend or provider acceptance.
- First browser pass exposed an ambiguous select accessible name; an explicit label corrected it. Initial CSS compatibility warnings were fixed. The existing stale Browserslist-data warning remains nonblocking.
- Screenshots: `notifications-desktop.png`, `notifications-mobile.png`. QA harness: `ui/scripts/notification-browser-qa.mjs`; it starts a loopback static server, intercepts SMS-history requests with synthetic data, then closes the browser/server. No customer database or provider call is used.
- Critical audit passed (0 critical; unchanged 4 high and 9 moderate transitive findings). No dependencies, provider settings, schemas, credentials, migrations, merges, deployments or customer data were changed. No message was sent.
- Remaining: durable enqueue recovery (history cannot reveal missing records), other event triggers, template/preferences UI, technician notifications, email and live acceptance. Planning estimate: APP-013 roughly 50%; governed APP-006 through APP-016 roughly 74%, not release scores.

### Review this UI section

1. Review the new notification page/styles/helpers, API read adapter, dispatch navigation and QA harness in PR #21. Compare both screenshots with the read-only contract.
2. In `ui`, run `npm run -s lint && npm test -- --runInBand && npm run -s build`.
3. Run `PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/notification-browser-qa.mjs` in this workstation's `ui` directory. On another workstation supply its installed Playwright module and optional `CHROME_PATH`. Only synthetic API responses are used.
4. Verify empty history is not presented as proof of successful notification, and that no sending/replay control exists. Live operator acceptance and release require separate approval.

## Technician on-the-way trigger checkpoint (2026-09-08)

- Refreshed both remotes and resumed backend `4937330` plus governance evidence `27cb56d`; canonical governance main `af8a340` still has APP-013 as its sole Now ticket. No completed payment or appointment-trigger work was repeated.
- The existing authenticated technician status workflow now queues the fixed customer `TECHNICIAN_ON_THE_WAY` SMS only after a changed `on_my_way` action commits its job write and audit transaction. Replays with `changed: false`, rejected/stale writes and failed commits never queue a message.
- JobsModule imports the public CommunicationsModule export; the workflow does not access provider transport. Existing consent, quiet-hour, encryption, idempotency and send-time checks remain authoritative.
- On-the-way identity now includes `technicianStatusUpdatedAt`, distinguishing a later departure by the same technician from retries within one departure. Earlier queued on-the-way digests fail closed after this change; appointment message identities are unchanged.
- Queue failure emits only a bounded event code, tenant ID and job ID (no raw error, phone, token or message body). Queue and logging failure cannot reverse committed technician status.
- Validation: backend build/lint, 36 suites / 323 tests (1 suite / 3 existing policy skips), architecture check and Prisma validation passed. Fifteen new regression cases cover post-commit ordering, no-op retry, invalid/missing/stale/audit/commit failures, queue/logging failure isolation, unrelated transitions, departure identity, and current versus obsolete delivery through a provider double. Initial test-double typing lint errors were corrected before the final clean run.
- Focused technician, transactional-message and delivery suites: 3 suites / 54 tests passed. Prettier and diff checks passed.
- Unchanged UI lint, 4 suites / 17 tests and build (13 static pages) passed. No UI or route changed; no new browser screenshot or rendered APP-013 acceptance is claimed.
- Critical audit passed: zero critical, 4 high and 9 moderate existing transitive findings. No dependency, schema, provider configuration, credential, deployment or real customer/job data was changed; no external message was sent.
- Remaining limitations: post-commit enqueue is not a durable outbox. A process crash or queue failure can leave committed status without a message; status replay does not auto-repair it. Operators must inspect queue history and current state before any separately authorized recovery. The pre-send check-to-provider race also remains. Assignment/payment/dispatcher and other technician events, email, preferences, UI and acceptance remain open.
- Planning estimate: APP-013 roughly 40%; governed APP-006 through APP-016 roughly 73%. These are not release acceptance scores.

### Review steps

1. In PR #21 review `technician-workflow.service.ts`, JobsModule wiring and the departure timestamp in `transactional-message-state.ts`.
2. Run `npm run -s build`, then `npm test -- --runInBand src/jobs/technician-workflow.service.spec.ts src/communications/transactional-messaging.service.spec.ts src/communications/sms-delivery.service.spec.ts`.
3. Confirm failed commits and unchanged retries never call the queue, queue failures preserve EN_ROUTE, and obsolete departure/assignment state never reaches the provider double. Review the outbox/recovery limitations before enabling any acceptance send.

## Appointment lifecycle identity and send-time revalidation (2026-09-08)

- Added automatic fixed-template SMS queueing after a successful initial appointment confirmation, completed reschedule and completed cancellation. The trigger runs after the authoritative job/calendar operation; queue or identity failure is logged without undoing the appointment.
- Lifecycle events use `lifecycle:<template-key>:<state-digest>` as the internal idempotency source. Only its existing tenant-keyed HMAC is persisted as the queue key. The SHA-256 lifecycle digest covers template-relevant canonical job status, recipient, tenant brand/timezone, schedule or technician state without storing those raw values in history output.
- Manual operator queueing records the same digest. Immediately before provider access, all transactional SMS reload the composite tenant/job record and compare its current digest. Missing/deleted, contradictory or changed state becomes `DEAD_LETTER` with `stale_lifecycle_state`; earlier transactional events without verifiable state metadata fail closed as `lifecycle_state_unavailable`.
- Focused scheduling, transactional-message and delivery suites passed: 3 suites / 44 tests. Regression cases prove each appointment trigger, deterministic lifecycle identity, a current-state send, stale/unverifiable-message rejection before provider access, and successful cancellation despite queue failure.
- Full backend gates passed sequentially: build, lint, 36 suites / 308 tests (1 suite / 3 existing policy skips), architecture check and Prisma validation. `npm audit --omit=dev --audit-level=critical` passed with zero critical findings; 4 high and 9 moderate existing transitive Prisma/Firebase findings remain because full remediation requires breaking upgrades.
- Unchanged UI regression gates passed: lint, 4 suites / 17 tests and production build with 13 static pages. No rendered UI changed, so the existing browser evidence remains applicable and no new screenshot is claimed.
- Outbound delivery stayed disabled. No provider message, credential/configuration change, migration, merge, deployment, billing action or real customer/job mutation occurred.
- Residual boundary: revalidation happens immediately before provider access but cannot make an external send atomic with a later concurrent job mutation. Automatic assignment/technician/payment/dispatcher triggers, email, preferences, UI and staging acceptance remain open.
- Estimate: APP-013 roughly 35%; APP-006 through APP-016 roughly 72%. These are planning estimates, not release acceptance scores.

Review: inspect the lifecycle digest and pre-send validator, run build before tests, and verify a changed appointment dead-letters without calling the provider. Review the three post-commit scheduling triggers and the regression proving queue failure cannot roll back a committed cancellation.

## Message state validation checkpoint (2026-09-08)

- Continued the existing transactional-messaging branch from `9eb1b3a` after fetching both remotes. Canonical governance `af8a340` confirms APP-012 and BE-008 are accepted and APP-013 is the sole Now ticket.
- Reproduced by code inspection: the operator endpoint could select cancellation for an active job or technician-on-the-way before the stored technician status was EN_ROUTE.
- Added queue-admission checks: soft-deleted jobs return the same 404 as missing/cross-tenant jobs; cancellation requires CANCELLED; other templates reject CANCELLED/COMPLETED; on-the-way requires an assignee in EN_ROUTE; confirmation/reschedule require a persisted calendar reference and complete, ordered service window.
- Invalid states produce HTTP 409 before rendering or delivery queue access. Valid state continues through the existing consent, encryption and idempotency boundary without changing message copy or provider delivery.
- Focused service suite: 16 tests passed, including 14 new regression cases. Full backend: 36 suites / 302 tests passed, with 1 suite / 3 existing policy skips; build, lint, Prettier, architecture and Prisma validation passed.
- The first parallel test run overlapped Prisma generation in prebuild and failed loading a temporarily missing generated client. Repeating the full suite after build finished passed; run generation/build before tests in this checkout.
- Critical dependency audit passed with 0 critical; 4 high and 9 moderate existing transitive findings remain. No dependency version was changed.
- UI regression checks passed: lint, 4 suites / 17 tests and Next build (13 static pages). Installed the lockfile-defined UI dependencies locally; no manifest or lockfile changed.
- No rendered UI changed; no new browser screenshot is applicable. Existing APP-013 application screens and end-to-end messaging browser QA remain future work.
- This is snapshot validation at queue admission, not an atomic lifecycle/send guarantee. Concurrent job changes, calendar operations in progress, proof of a completed reschedule event, and stale queued messages require lifecycle integration before release.
- No external message, credential change, migration, merge or deployment occurred. APP-013 remains active and unreleased.
- Estimate: APP-013 roughly 20%; APP-006 through APP-016 roughly 70%. These are planning estimates, not release acceptance scores.

Review: inspect the service and its regression matrix, run `npm run -s build` followed by `npm test -- --runInBand`, and verify invalid state never calls the delivery queue. Review alongside the existing foundation in PR #21; lifecycle triggers and send-time revalidation remain the next bounded work.

## Transactional messaging foundation checkpoint

- Added four fixed, versioned customer SMS templates: appointment confirmed, appointment rescheduled, appointment cancelled, and technician on the way.
- Templates use the contractor tenant name, tenant-local appointment time, and assigned technician name when available. Every message includes STOP and HELP instructions.
- Added authenticated owner/admin/dispatcher `POST /communications/sms/transactional`. It accepts only a tenant-scoped job UUID, an approved template key, and an idempotency key; callers cannot submit arbitrary message text or recipient phone numbers.
- Job, customer, contractor branding, timezone, appointment time, and technician identity are loaded server-side through the existing composite tenant boundary.
- Rendered recipient and message content use the existing encrypted communication-content path. The durable event records template ID, template key, template version, job linkage, delivery state, attempt count, and bounded failure information.
- Added authenticated, no-store `GET /communications/sms/history`, optionally filtered by tenant-scoped job. Results are capped at 100 and exclude message text, phone number, recipient hash, provider identifiers, and encrypted content.
- Queue creation continues to fail closed through the existing consent, tenant identity, recipient-local quiet-hours, idempotency, retry, and global delivery-enable controls.
- This checkpoint does not automatically trigger lifecycle messages, add the operator UI, send a provider message, change configuration, or alter staging/production state.

### Checkpoint validation

- Focused communications tests: 4 suites and 21 tests passed.
- Full test suite: 36 suites passed, 1 existing policy-skipped suite; 288 tests passed and 3 existing tests skipped.
- Build: passed.
- Lint: passed.
- Architecture check: passed.
- Prisma validation: passed.
- Diff check: passed.

### Review disposition

- APP-013 remains `Now`; this is the first review-ready application checkpoint on top of the accepted BE-008 transport.
- Remaining APP-013 work includes lifecycle trigger integration, dispatcher alerts, customer/technician notification preferences, operator UI, rendered browser QA, monitoring/cost presentation, and staging acceptance.
- No migration, merge, deployment, credential access, Twilio configuration, billed provider action, or real customer message was performed.

## Bounded scope

- Signmons inbound voice and SMS transport remains available 24/7.
- Tenant business hours describe human availability and escalation expectations; they do not disable automated intake.
- Outbound SMS quiet hours are now named `outboundQuietHoursStart` and `outboundQuietHoursEnd` so they cannot be mistaken for tenant office hours.
- Existing deployments using legacy `quietHoursStart` and `quietHoursEnd` remain readable during migration.
- Equal outbound quiet-hour bounds mean no suppression and require explicit compliance review before activation.
- Outbound SMS remains disabled in staging.

## Staging correction

- Staging routes 100 percent of traffic to revision `signmons-calldesk-staging-be008bounds`.
- Liveness and database readiness returned HTTP 200.
- Unsigned Twilio voice requests fail closed with HTTP 401.
- Inbound voice and SMS remain available 24/7.
- The independent recipient-local outbound SMS quiet window is 9 PM to 8 AM.

## Validation

- Focused configuration and communications tests: 55 passed.
- Full test suite: 34 suites passed, 1 existing suite skipped; 280 tests passed, 3 existing tests skipped.
- Build: passed.
- Lint: passed.
- Architecture check: passed.
- Diff check: passed.

## Release disposition

- PR `#18` merged at `b6f1d13fb798e115eb7e8365a416a8fe07fe6123`.
- Cloud Build `a3f8fa04-5753-443d-b3e8-c4ba3b151536` produced immutable image digest `sha256:37286933d882466b8592120f48eb69c34e14cdb5a23c1f37480e39a1e6ff933a`.
- Cloud Run revision `signmons-calldesk-staging-app013bounds` passed zero-traffic liveness, readiness, unsigned voice rejection, unsigned SMS rejection, and outbound-specific configuration checks before promotion.
- The revision now serves 100 percent of staging traffic; routed liveness and readiness return HTTP 200, and the Twilio voice/SMS webhook URLs still match exactly.
- Inbound voice and SMS remain available 24/7. The separate outbound quiet window is 9 PM to 8 AM recipient-local, and outbound SMS remains disabled.
- The temporary build service account was disabled after release and retains zero project, Artifact Registry repository, and Cloud Build bucket roles.
