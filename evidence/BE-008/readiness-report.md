# BE-008 Review Checkpoint - Governed Twilio Transport Foundation

Date: 2026-09-07

## Bounded scope

This checkpoint establishes the provider boundary, consent controls, and durable outbound delivery state required by BE-008. It does not send SMS, connect live Twilio credentials, enable recording or transcription, deploy, or mutate customer/job state.

Implemented:

- `POST /webhooks/twilio/voice` and `POST /webhooks/twilio/sms` transport boundaries.
- Official Twilio request-signature validation using the configured public webhook URL and Auth Token.
- Signature verification before tenant/destination resolution.
- Exact one-tenant resolution by enabled E.164 destination and explicit `test`, `staging`, or `production` environment.
- Fail-closed behavior for missing configuration, invalid signatures, unknown destinations, cross-environment identities, and duplicate enabled destination ownership.
- XML-escaped tenant voice greeting and empty inbound SMS TwiML; neither path starts recording or mutates workflow state.
- Production configuration requires HTTPS and an origin-only webhook base URL.
- Persistent, tenant-scoped SMS consent evidence using HMAC phone lookup hashes rather than plaintext phone numbers.
- Verbal accept/decline evidence with disclosure version, timestamp, source, and privacy-safe audit records.
- Server-side STOP suppression, prior-opt-out-only START restoration, and HELP auditing.
- Twilio Advanced Opt-Out `OptOutType` handling without duplicate customer replies.
- Outbound consent decisions that fail closed for missing consent, opt-out, and tenant-local quiet hours.
- Provider-abstracted outbound SMS creation with database-enforced tenant idempotency and encrypted destination/content storage.
- Atomic delivery claims that prevent concurrent workers from sending the same queued event.
- Signed Twilio delivery-status callbacks with tenant/sender binding, provider-message binding, idempotent updates, and terminal-state regression protection.
- At most three delivery attempts with exponential delay only after explicit retry-safe provider rejection.
- Ambiguous transport outcomes are dead-lettered immediately instead of automatically retried, preventing a timeout-after-acceptance from causing a duplicate message.
- Disabled-by-default retry processing, privacy-safe dead-letter visibility, and acknowledgment-gated audited replay.
- Authenticated, tenant-scoped operator endpoints expose privacy-safe metrics and dead letters; dispatcher/admin/owner may inspect, while replay is restricted to admin/owner.
- Replay requires an explicit duplicate-risk acknowledgment and a bounded operator reason.
- Added an outage, rollback, monitoring, activation, and credential-rotation runbook with delivery disabled as the first reversible control.

Deferred to the next BE-008 checkpoint:

- Operator UI for dead-letter review and replay.
- Provider-billed cost ingestion and production alert wiring; the current API provides message volume, attempts, status, and bounded failure-code telemetry.
- Executed provider-outage, rollback, and credential-rotation drills.
- Sandbox credentials, Twilio Console status-callback configuration, Virtual Phone proof, real calls, deployment, and activation.

## Objective evidence

- Build: passed.
- Tests: 33 suites passed, 1 existing suite skipped; 277 tests passed, 3 existing tests skipped.
- Focused communications and configuration tests: 67 passed.
- Architecture check: passed.
- Lint: passed.
- Diff check: passed.
- Prisma schema validation: passed.
- Full migration chain: passed in a fresh disposable PostgreSQL database; delivery-state columns were verified and the database was removed.

## Safety disposition

- No credential values or provider payloads are committed.
- No Twilio Account, Messaging Service, Campaign, Brand, phone-number, call, or message identifiers are returned by the webhook API.
- Recording and transcript capture remain disabled.
- The reviewed code and additive migrations are released to staging with delivery disabled; Twilio credentials, provider configuration, sandbox traffic, and live activation remain separately approval-gated.

## Governed staging release - 2026-09-07

- Primary PR `#15` merged at `c94b8dcfc5c33ebbeca17353e33faa111eab10f7`.
- The first zero-traffic candidate exposed a missing `AuthModule` import for the communications operator controller. It never received traffic. The correction added explicit authentication wiring plus an architecture regression check; PR `#16` merged at `fd6828a5b13d07e09b7c69edf435959e0882ae5d` after all 277 tests and required gates passed.
- Cloud Build `650b6172-b608-435c-89ea-9a3d9a61adfc` produced the corrected merge image with digest `sha256:f95c830f956710caa2f9d6f7418f8ba6da5d68eb38feb3e4f6e4fc580ef0edf6`.
- Migration execution `signmons-calldesk-migrate-jrq7h` completed successfully against the exact corrected image.
- Cloud Run revision `signmons-calldesk-staging-be008release` became healthy and now serves 100 percent of staging traffic.
- Candidate and routed checks returned HTTP 200 for liveness/readiness. The unauthenticated metrics endpoint returned 401. The unsigned, unconfigured Twilio voice webhook failed closed with 503.
- `SMS_DELIVERY_ENABLED=false` is explicit on the released revision. No Twilio credential was accessed, no webhook identity was configured, and no call or SMS was initiated.
- Temporary build access was removed after release: the dedicated build service account is disabled and has zero project, Cloud Build bucket, and Artifact Registry repository bindings.
- At this release checkpoint, Twilio sandbox acceptance was still pending; the subsequent acceptance section records its completion.

## Staging acceptance - 2026-09-07

- Twilio credentials are referenced from Google Secret Manager; values were not committed or written to evidence.
- The Signmons number is attached to the verified Signmons Dispatch messaging service. Voice and SMS POST webhooks resolve the staging tenant and reject unsigned requests.
- An authorized inbound call completed and returned the tenant-specific automated-assistant greeting. Inbound voice and SMS remain available 24/7; tenant business hours describe human availability only.
- STOP created one tenant-scoped `OPTED_OUT` record and audit event. START created one restoration audit event and left the final consent state `OPTED_IN`.
- One explicitly authorized transactional staging SMS was queued through `SmsDeliveryService`, claimed once, received on the test phone, and advanced to `DELIVERED` through the signed per-message Twilio status callback. No duplicate was created.
- A simulated provider rejection produced `DEAD_LETTER` without contacting Twilio. The record appeared in the privacy-safe dead-letter list; replay without duplicate-risk acknowledgment was rejected; acknowledged replay created one audit record and the simulated second attempt dead-lettered again.
- The broad messaging-service status callback was removed so Twilio-managed keyword replies do not enter the application delivery ledger. Application-created messages retain their per-message `/webhooks/twilio/sms/status` callback.
- The temporary quiet-hour bypass was removed immediately after the single delivery. Staging returned to recipient-local outbound quiet hours of 9 PM to 8 AM, `SMS_DELIVERY_ENABLED=false`, an empty queued/sending set, healthy liveness/readiness, and 100 percent traffic on `signmons-calldesk-staging-app013bounds`.
- Permanent availability-boundary naming shipped through PR `#18`: `outboundQuietHoursStart` and `outboundQuietHoursEnd` cannot be confused with contractor business hours, while legacy values remain readable during migration.
- Required code gates passed before release: build, lint, architecture, diff, 55 focused communications/configuration tests, and 280 full-suite tests; 3 existing tests remained skipped.
- BE-008 acceptance is complete. APP-013 remains active for transactional templates, notification-center UI, event selection, and operator delivery visibility.
