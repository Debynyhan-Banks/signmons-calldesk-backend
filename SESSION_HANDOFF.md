# Backend Session Handoff

Last Updated: 2026-09-07

## Current Program Pointer

- Active ticket: `APP-013` Twilio-backed notification center and transactional customer messaging.
- APP-012 is owner-approved, merged and released from PR `#14` at `068f4c2`.
- APP-011 is owner-approved, merged and released from PR `#13` at `28d394f`.
- Keep the WIP limit at one; APP-013 implementation has not started.

## APP-012 Review Checkpoint

- Branch: `codex/app-012-payment-gate` from backend `origin/main` at `8247a0a`.
- Implemented one bounded vertical slice: the provider-independent payment-before-dispatch gate.
- `depositRequired` and `serviceFeeRequired` now share one fail-closed reducer across intake readiness and dispatch.
- Required jobs stay in `NEW_REQUEST`, expose a privacy-safe payment-gate status, return no eligible recommendation and reject new assignment until canonical payment status is `SUCCEEDED`.
- `/app/dispatch` shows the lock reason and disables the assignment controls; desktop and 390px browser evidence is in `evidence/APP-012/`.
- Backend build/lint, 24 suites and 175 tests, architecture and Prisma validation pass. UI build/lint and 4 suites/17 tests pass.
- Isolated local HTTP proof verified pending -> HTTP 409/no mutation/no audit and simulated succeeded -> unlocked/recommendation. The fixture was removed.
- No Stripe call/configuration, production migration, deployment, IAM, billing or real-data action occurred.
- Evidence: `evidence/APP-012/readiness-report.md`.

## APP-012 Payment Request Checkpoint

- Continued `codex/app-012-payment-gate` with one bounded backend-only payment/deposit request section.
- Added authenticated owner/admin/dispatcher `POST /jobs/:jobId/payment-requests` and privacy-safe `GET /jobs/:jobId/payment-request` endpoints.
- Required amount/currency come only from the job's tenant policy and pricing snapshots. Stale, closed, missing/cross-tenant, incomplete-pricing and unready connected-account cases fail before provider access.
- Checkout creation is idempotent and uses a direct Stripe charge on the contractor tenant's connected account with a zero Signmons application fee. Only a SHA-256 request-key hash is stored; provider identifiers and checkout URLs stay out of tracking/audit projections.
- Added request success/failure audits and migration `20260904100000_add_payment_request_tracking`.
- Backend build/lint, 26 suites and 189 tests, architecture and Prisma validation pass. A disposable local PostgreSQL schema passed all migrations and authenticated POST/replay/GET proof with one success audit, then was removed.
- No live Stripe request, Stripe/IAM/secret configuration, staging or production migration, deployment, billing or real-data action occurred. No rendered UI changed, so no new visual browser artifact was warranted.
- APP-012 is approximately 60% complete; APP-006 through APP-016 is approximately 61% complete.

## APP-012 Webhook Transition Checkpoint

- Added public `POST /webhooks/stripe` with exact-raw-body Stripe signature verification and a five-minute replay tolerance.
- Connected-account events resolve the tenant from the stored account binding, then resolve only a payment belonging to that tenant and destination account. Paid events must match the trusted amount and currency.
- Existing `StripeEvent` storage makes delivery idempotent; duplicate delivery does not repeat payment or audit mutations. Stored payload/audit evidence is bounded and excludes customer payload fields and provider identifiers.
- Handles paid Checkout completion, asynchronous success/failure, Checkout expiration, PaymentIntent failure, and full/partial charge refunds. Late success cannot overwrite a refunded state.
- Production Checkout configuration now fails closed without `STRIPE_WEBHOOK_SECRET`.
- Backend build/lint, 27 suites and 200 tests, architecture and diff checks pass; 1 suite/3 tests remain skipped by the existing database-test policy.
- A separate sandbox exercise completed contractor onboarding and a $100 Checkout payment. No live-mode payment, endpoint configuration, production secret change, migration, deployment, or release occurred.
- Stripe CLI then forwarded a genuine signed Connect `checkout.session.completed` event to the compiled local backend on an isolated disposable database. A mismatched amount returned HTTP `422` with no mutation; the aligned event changed `PENDING` to `SUCCEEDED` with exactly one processed event and one bounded webhook audit, while the application fee remained zero.
- All temporary processes, database/schema fixtures, and ephemeral-secret logs were removed. The shared historical `legacy_2025` archive was preserved after its fixed name blocked the first schema-scoped migration attempt.

## APP-012 Customer Recovery Checkpoint

- Extended the existing signed customer booking-link action boundary with `continue_payment`; the customer needs no separate account, and an ordinary booking-status read never returns the Checkout URL.
- Recovery returns only the already-created session when the tenant-scoped payment is pending, both local and provider expiry are in the future, the provider reports it open and unpaid, and the stored destination still exactly matches the tenant's enabled connected account.
- Recovery does not create a new Checkout or charge. Its bounded customer audit excludes the Checkout URL and provider/account identifiers.
- Added a responsive pending-payment action to `/appointment/manage` and a `/payment/status` success/cancel page. The success page does not claim fulfillment from the redirect; webhook state remains authoritative.
- Local browser QA passed at desktop and 390px: the pending-payment action is visible and 50px high, the booking page remains available, and there is no horizontal overflow. Success and cancel return states rendered without application console warnings/errors.
- Final gates pass: backend build/lint/architecture/Prisma validation and 27 suites/206 tests; UI lint/static build and 4 suites/17 tests.
- This section remains review-only. No live-mode call, persistent Stripe configuration, migration, deployment, or release occurred.
- APP-012 is approximately 70% complete; APP-006 through APP-016 is approximately 63% complete.

## APP-012 Operator Payment Visibility Checkpoint

- Added an authenticated payment operations panel to `/app/dispatch` for owner/admin/dispatcher roles. It shows the job's trusted request amount, request status/expiry, and a bounded signed-event timeline.
- Operators can create a request only through the existing server-authoritative endpoint. The UI supplies the currently loaded job version and a new UUID idempotency key; the temporary Checkout URL appears only in the successful authorized response for opening or copying.
- Added tenant/job-scoped `GET /jobs/:jobId/payment-events`, capped at the newest 20 events and filtered through the job's internal payment ID. It returns only internal row ID, bounded type/status and timestamps—never Stripe event/account/session/payment-intent IDs, payloads or error text.
- Desktop and 390px browser QA passed with trusted `$100.00` fixture display, active-request lock, human-readable verified event, 44px phone control, and no horizontal overflow.
- This section remains review-only. No live Stripe call, persistent configuration, migration, deployment, merge, or release occurred.
- Final gates pass: backend build/lint/architecture/Prisma validation and 27 suites/208 tests; UI lint/static build and 4 suites/17 tests.
- APP-012 is approximately 80% complete; APP-006 through APP-016 is approximately 65% complete.

## APP-012 Governed Payment Exception Checkpoint

- Added owner/admin-only `POST /jobs/:jobId/payment-exception` with approve/revoke actions, normalized 10-500 character reason, throttling, no-store response, tenant scope and optimistic job concurrency.
- Approval requires the job's trusted policy snapshot to explicitly select `paymentGateMode: manual_override` plus a currently active/trialing Growth, Pro or Enterprise subscription period. Starter and missing/expired entitlements fail closed before mutation.
- A successful exception uses the distinct `PAYMENT_EXCEPTION_APPROVED` gate reason and leaves canonical payment truth unchanged; pending remains pending rather than being relabeled paid.
- Approval and revocation atomically update the job policy snapshot and write bounded user audits. Revocation does not require an ongoing advanced entitlement, preventing a downgrade from trapping an unsafe exception open.
- Focused guard/service/policy tests pass for role denial, entitlement denial, governed unlock, untrusted exception rejection, revocation and stale-write protection. This backend-only section changes no rendered UI.
- No database schema change, Stripe call/configuration, deployment, merge, or release occurred.
- Final gates pass: backend build/lint/architecture/Prisma validation and 28 suites/221 tests; unchanged UI lint/static build and 4 suites/17 tests.
- APP-012 is approximately 88% complete; APP-006 through APP-016 is approximately 67% complete.

## APP-012 Final Acceptance Preparation

- Added `evidence/APP-012/release-checklist.md` with a linked acceptance matrix, exact Stripe Connected accounts event set, vault/restricted-key requirements, continuous staging acceptance sequence, negative cases, cleanup, rollback/monitoring and separate live release gate.
- The linked local lifecycle evidence receives a conditional pass: operator request, signed customer recovery, genuine Stripe CLI Connect transition, canonical dispatch unlock, bounded operator visibility and governed exceptions are proven across isolated evidence.
- This is not a deployed end-to-end claim. Continuous staging execution requires explicit owner authorization for staging deployment, migration and Stripe sandbox endpoint configuration.
- No Stripe endpoint, secret, IAM policy, database, deployment, merge, release or live-mode state was changed in this section.
- APP-012 is approximately 95% complete; APP-006 through APP-016 is approximately 68% complete.

## APP-012 Webhook Mode Boundary Checkpoint (2026-09-07)

- Added explicit `STRIPE_WEBHOOK_LIVEMODE` configuration and rejected handled signed events before database access when their top-level Stripe `livemode` does not match the configured environment.
- Production validation now requires an explicit webhook mode whenever Stripe Checkout or webhook credentials are configured and rejects recognizable live/test key prefixes that conflict with it.
- Focused webhook/config validation passed 2 suites and 25 tests. Full backend build/lint, 28 suites and 224 tests, architecture, Prisma validation and the critical audit gate pass; unchanged UI lint/build and 4 suites/17 tests also pass.
- This server/config-only hardening changes no rendered UI, so the existing September 6 desktop/390px browser evidence remains applicable and no new visual artifact was warranted.
- No endpoint, credential, IAM policy, database, payment, deployment, merge, release or customer state was changed. APP-012 remains approximately 95% complete and unreleased pending explicit staging acceptance approval.

## APP-012 Governed Staging Acceptance (2026-09-07)

- Owner-authorized sandbox work deployed reviewed commit `27d595da21406704b6bc66804ba03d2e90643b23` as Cloud Run revision `signmons-calldesk-staging-app012correct`, now serving 100 percent of staging traffic with explicit test webhook mode.
- The active Stripe `Signmons LLC` test destination receives the six approved Connected accounts events at the staging `/webhooks/stripe` endpoint. Signing material is held in Secret Manager version 5 and is not recorded in source or evidence.
- A genuine Stripe CLI event reached the deployed endpoint with a valid signature and failed closed as an unrecognized generic payment. The exact owner-submitted `$100.00 USD` paid Checkout event then returned 200 through a secure deployed replay and changed canonical state from `PENDING` to `SUCCEEDED` with zero application fee, tenant destination match, one processed event, one bounded transition audit and dispatch unlock.
- Duplicate replay returned 200 without adding a second event or transition audit. The disposable tenant and Identity Platform operator were deleted; temporary secret/event files and temporary IAM grants were removed.
- A new post-destination disposable `$100.00 USD` Checkout then delivered automatically from Stripe with HTTP 200. Canonical status became `SUCCEEDED`, fee stayed zero, tenant destination matched, dispatch unlocked and exactly one processed event/transition audit was stored. Workbench resend also returned HTTP 200 with `duplicate: true` while database counts stayed one.
- Evidence: `evidence/APP-012/release-checklist.md`. APP-012 sandbox implementation and acceptance are 100% complete; APP-006 through APP-016 is approximately 69% complete. Merge, production release, live-mode configuration and a real transaction remain separately approval-gated.

## APP-012 Release (2026-09-07)

- Owner authorized merge and staging release. PR `#14` merged the accepted branch to backend `main` at `068f4c27daf00ee4967fd5d77432e0605fedf044`.
- Release gates passed before merge: backend build, 224 tests with 3 policy-skipped, architecture and Prisma validation; UI lint/static build and 17 tests.
- Cloud Build `dd7ca7ec-1777-45b6-8659-fba8998a9b63` produced image `068f4c2` with digest `sha256:838121ce33dc17343ec2182bee83d39118626a68aa702802b13205635d501a33`.
- Migration execution `signmons-calldesk-migrate-pgr84` completed successfully from that digest. Cloud Run revision `signmons-calldesk-staging-app012release` serves 100 percent of staging traffic.
- Firebase Hosting published the exact merged build. `/app/dispatch`, `/appointment/manage` and `/payment/status` return HTTP 200; backend liveness/readiness return 200, approved-origin CORS is present and unsigned Stripe webhook traffic fails closed with 400.
- Temporary build bucket, Artifact Registry and logging grants were removed and `signmons-build` was disabled. The sandbox Stripe destination and vault secret remain staging-only; no live-mode key, production payment or real transaction was authorized.
- APP-012 is Done. APP-013 is promoted to Now without beginning implementation.

## APP-011 Implementation

- Added a public, rate-limited `POST /appointments/manage` boundary that treats the HMAC secure-link token as authority and keeps the existing tenant-authenticated webchat endpoint compatible.
- Added a responsive customer route at `/appointment/manage` with request, appointment, technician and payment status summaries.
- Added explicit `confirm` and `request_reschedule` actions; existing availability, direct reschedule and cancellation behavior remains compatible.
- Preserved the existing lowercase appointment `state` contract and added richer customer status as `bookingState`.
- Customer confirmation, reschedule request and direct reschedule events are tenant-scoped and audit logged with `AuditActorType.CUSTOMER`.
- Dispatch detail now exposes the latest customer response and a short customer-booking event timeline.
- Secure-link payloads remain in the URL fragment, are not sent in query strings and are never returned to the dispatcher UI.

## Validation

- Backend: build passed; 163 tests passed with 3 skipped; architecture check passed.
- Frontend: lint passed; static production build passed; 17 tests passed.
- Browser QA: desktop and phone layouts passed with no horizontal overflow; touch actions are 50px high; reschedule disclosure and accessible labels verified.
- Repository-wide backend lint still reports five pre-existing APP-010 findings in `src/jobs/routing.service.ts`; lint is not an APP-011 backend completion gate and APP-011 introduced no lint findings.
- Evidence: `evidence/APP-011/readiness-report.md` and customer status screenshots in the same directory.

## APP-011 Release

- Cloud Build `5c478614-709a-4f15-9579-e964d7bcca67` produced image `28d394f` with digest `sha256:6721f0d940fd97890d6c75e5ba7e4e5de3e4c1163b4f20a3f975fac80701d787`.
- Migration execution `signmons-calldesk-migrate-xztrh` completed successfully.
- Cloud Run revision `signmons-calldesk-staging-00024-wwn` serves 100 percent of staging traffic.
- Firebase Hosting published `/appointment/manage`; live liveness, readiness, CORS and fail-closed secure-link checks passed.
- Temporary build access was fully revoked and `signmons-build` was disabled after the build.

## Next Actions

1. Reconcile APP-013 with its Twilio transport/compliance prerequisites before implementation.
2. Keep Stripe sandbox and live credentials separated; APP-012 live-mode activation remains separately approval-gated.
3. Keep Stripe secrets server-side and maintain the contractor-to-customer payment boundary; Signmons tenant pricing remains subscription-only.
4. Do not begin APP-013 implementation without a bounded plan and owner direction.

## Restart Commands

```bash
git status --short
npm run -s build
npm test -- --runInBand
npm run -s arch:check
cd ui && npm run -s lint && npm run -s build && npm test -- --runInBand
```
