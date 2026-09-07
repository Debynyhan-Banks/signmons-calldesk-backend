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
- This checkpoint is review-ready only; merge, environment configuration, staging release, and live traffic remain separately approval-gated.
