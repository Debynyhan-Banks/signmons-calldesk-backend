# APP-012 Payment Gate, Request, Webhook, Recovery, And Operator Visibility Checkpoints

Date: 2026-09-06
Branch: `codex/app-012-payment-gate`
Ticket: `APP-012` payment gate and webhook status workflow
Checkpoint: bounded payment-before-dispatch gate, authenticated payment-request API and operator controls, signed webhook transitions and visibility, and secure customer recovery/status UI; review-ready, not released

## Outcome

These checkpoints implement five bounded APP-012 vertical slices. A shared, provider-independent policy derives whether payment is required from the job's tenant-policy snapshot. Required jobs remain locked until canonical payment state `SUCCEEDED`; the backend prevents new assignment and the dispatcher UI explains the lock. An authenticated backend API and operator surface can create and track the required contractor-to-customer checkout request without exposing provider identifiers. A public Stripe webhook boundary verifies signatures over the exact raw body, binds connected-account events to the tenant, applies idempotent payment transitions, and persists bounded event/audit evidence that operators can now see as a privacy-safe job timeline. The existing signed customer booking link can recover only its current open, unpaid, unexpired Checkout session, while the return page leaves fulfillment authority with the webhook.

APP-012 remains in `Now`. Governed exception/manual-override behavior, persistent environment endpoint configuration, final end-to-end acceptance, and release work remain later APP-012 sections.

## Runtime Contract

- A job requires payment before dispatch when `depositRequired` or `serviceFeeRequired` is explicitly `true` in its policy snapshot.
- Gate states are `NOT_REQUIRED`, `LOCKED` and `UNLOCKED`.
- Only `PaymentStatus.SUCCEEDED` unlocks a required job. Not requested, pending, failed, canceled and refunded states fail closed.
- `GET /jobs/dispatch-board` and `GET /jobs/dispatch-board/:jobId` expose a privacy-safe `paymentGate` projection with required/state/status, total/currency, a bounded reason code and operator-facing label.
- A locked, unassigned, non-escalated job remains in `NEW_REQUEST`, returns no eligible dispatch recommendation and disables new assignment. An urgency escalation remains visibly `ESCALATED`, but still cannot be assigned while locked.
- `POST /jobs/:jobId/assignments` returns conflict before candidate lookup or mutation when the gate is locked. The rejected operation leaves both assignment and audit history unchanged.
- Existing assignments are not silently removed if payment later becomes locked; follow-up/refund handling remains an explicit later workflow.
- No Stripe payment intent, checkout session, charge, credential or secure-link value is returned by this projection.

## Implementation

- Added `src/payments/payment-gate.policy.ts` as the shared payment policy reducer.
- Reused the reducer in intake readiness so deposit and service-fee requirements cannot drift from dispatch enforcement.
- Added fail-closed dispatch queue, recommendation and assignment enforcement.
- Added a visible payment-gate panel and locked assignment controls to `/app/dispatch`.
- Mechanically corrected five pre-existing APP-010 lint findings in `src/jobs/routing.service.ts`; postal-code behavior remains string-only and unchanged for the typed service-area DTO.
- Added `src/payments/payment-requests.service.ts` and a narrow Checkout provider interface. The service derives the amount and currency exclusively from trusted job snapshots, reserves a tenant-scoped request, rejects unsafe state, and persists bounded success/failure audits.
- Added `POST /jobs/:jobId/payment-requests` and `GET /jobs/:jobId/payment-request`, protected by verified operator authentication, tenant context, owner/admin/dispatcher roles, throttling and no-store responses.
- Added the Stripe Checkout adapter as a direct connected-account charge with no application fee. It is fail-closed when the server secret or tenant payment readiness is absent; no real provider call was made in this checkpoint.
- Added migration `20260904100000_add_payment_request_tracking` for the hashed idempotency key, requested timestamp and checkout expiry. Checkout URLs and provider secrets are not stored.
- Added `POST /webhooks/stripe` with raw-body HMAC-SHA256 signature verification, a five-minute replay tolerance, connected-account-to-tenant binding, tenant-scoped payment lookup, and duplicate-event suppression through the existing `StripeEvent` model.
- Added fail-closed amount/currency validation before successful payment transitions. Checkout completion, asynchronous success/failure, expiration, PaymentIntent failure, and full/partial charge refunds map to canonical payment and refund states without allowing a late success event to overwrite a refund.
- Webhook event storage is bounded to event type, internal payment ID, and Stripe-created timestamp. Customer payloads and provider identifiers are not copied into audit metadata. Production Checkout configuration now also requires `STRIPE_WEBHOOK_SECRET`.
- Extended the signed `/appointments/manage` boundary with `continue_payment`. Ordinary status reads expose only `canContinue`; the Checkout URL is returned only after this authorized action.
- Recovery never creates a new Checkout. It requires a tenant-scoped pending payment, future local expiry, the same currently enabled connected account, and a provider-confirmed open, unpaid, unexpired session whose URL is on Stripe Checkout's HTTPS host.
- Added `/payment/status` success/cancel copy that treats the redirect as advisory and directs the customer back to the booking page for webhook-confirmed status.
- Added an authenticated payment operations panel to `/app/dispatch`. It shows trusted amount/currency, request state and expiry, creates a request with a fresh UUID idempotency key, and exposes the temporary Checkout URL only in the immediate authorized response.
- Added tenant/job-scoped `GET /jobs/:jobId/payment-events`, limited to 20 newest records and projected to internal row ID, bounded event type/status, and timestamps. Stripe event/account/session/payment-intent IDs, payloads and error text are not returned.

## Automated Evidence

### Backend

- Focused payment request, provider, recovery, and operator-event tests: 3 suites and 29 tests passed.
- Full tests: 27 suites and 208 tests passed; 1 suite/3 tests skipped by the existing database-test policy.
- `npm run -s build`: passed.
- `npm run -s lint`: passed with no errors.
- `npm run -s arch:check`: passed.
- `npx prisma validate`: passed.
- `npm audit --omit=dev --audit-level=critical`: passed with no critical advisory gate failure; 4 high and 9 moderate transitive findings remain in Prisma/Firebase dependency paths, and the suggested full remediations require breaking-version changes.

Focused coverage proves:

- deposit and service-fee policies both lock without successful payment;
- pending, failed, canceled and refunded states remain locked;
- successful payment unlocks dispatch;
- locked scheduled work stays out of `READY_TO_ASSIGN`;
- locked assignment returns before candidate lookup, job mutation or audit creation;
- payment projections do not expose Stripe identifiers.
- checkout requests require tenant/role context, current job state, server-authoritative pricing and an enabled contractor connected account;
- direct-account Stripe requests carry no Signmons application fee;
- exact idempotency replay produces no duplicate success audit;
- provider failure is persisted as failed and audited with a bounded reason code;
- operator tracking excludes Checkout session, PaymentIntent, account and request-key values.
- invalid and stale webhook signatures fail before database access;
- connected accounts that do not map to a tenant fail closed;
- paid events with mismatched amount/currency cannot unlock dispatch;
- duplicate deliveries acknowledge without repeating payment or audit mutations;
- asynchronous failures, PaymentIntent failures and expired sessions transition only pending payments;
- full refunds update both payment and refund state, and late success delivery cannot downgrade a refund;
- stored webhook/audit evidence excludes customer payload fields.
- signed customer recovery cannot cross tenants or connected accounts, cannot revive expired/completed sessions, and creates only a bounded customer audit without copying provider identifiers or URLs.
- operator webhook visibility resolves the job's internal payment first, filters by both tenant and internal payment ID, returns at most 20 events, and excludes stored payload/provider identifiers.

### Frontend

- `npm run -s lint`: passed with no warnings or errors.
- `npm test -- --runInBand`: passed, 4 suites and 17 tests.
- `npm run -s build`: passed; `/app/dispatch`, `/appointment/manage`, and `/payment/status` exported successfully.

## Local HTTP Proof

An isolated `calldesk_test` tenant/job/payment fixture was created after applying the two already-committed local test-schema migrations. No staging or production database was accessed.

- Pending required payment: list response returned `queue: NEW_REQUEST`, `state: LOCKED`, `paymentStatus: PENDING` and `reasonCode: PAYMENT_PENDING`.
- Assignment attempt: HTTP `409`; database verification showed the job remained unassigned and assignment-audit count remained `0`.
- Simulated successful canonical payment state: detail response returned `queue: READY_TO_ASSIGN`, `state: UNLOCKED`, `reasonCode: PAYMENT_SUCCEEDED`, one eligible candidate and a `dispatch-v2` recommendation.
- The isolated tenant was deleted after verification; cascade cleanup returned the fixture count to `0`.

This HTTP proof validates gate consumption. The signed webhook transition behavior is independently covered by the focused automated suite; a deployed Stripe endpoint delivery has not yet been configured or claimed.

The payment-request section was then exercised through the compiled Nest application with an overridden no-network Checkout provider and a disposable PostgreSQL schema:

- All 11 committed migrations, including `20260904100000_add_payment_request_tracking`, applied successfully.
- Authenticated create, exact replay and tracking requests returned HTTP `201`, `201` and `200`.
- The payment persisted as `PENDING` for `12500` cents with `applicationFeeAmountCents=0` and a stored Checkout session reference.
- The exact replay invoked the idempotent provider boundary but left exactly one `payment.request_created` audit.
- API responses exposed neither the provider Checkout session nor PaymentIntent identifier.
- The local fixture was cascade-deleted and the disposable schema `calldesk_app012_20260904a` was dropped after proof.

## Stripe Sandbox Webhook Delivery Proof

The compiled backend was started on port `3202` against a disposable local PostgreSQL database. Stripe CLI listened for Connect `checkout.session.completed` events and forwarded them to `POST /webhooks/stripe` using an ephemeral signing secret that was neither printed nor saved in the repository.

- The disposable tenant was bound to the sandbox `Signmons Test HVAC` connected account; its payment began `PENDING` with zero application fee.
- A first genuine signed Connect event carried the correct internal payment reference but Stripe CLI's default fixture amount did not match the trusted local amount. The endpoint returned HTTP `422`, the payment stayed `PENDING`, and no Stripe-event or audit record was persisted.
- After aligning the disposable trusted fixture to Stripe CLI's $30 fixture amount, a new signed Connect event returned success and transitioned the payment to `SUCCEEDED`.
- Database verification showed exactly one `StripeEvent` in `PROCESSED` state and exactly one `payment.webhook_transitioned` audit with actor type `WEBHOOK`.
- The stored event payload contained only event type, Stripe-created timestamp, and internal payment ID. The audit contained only bounded transition metadata. Provider event/session/payment-intent/account identifiers and customer fields were not copied into either projection.
- `applicationFeeAmountCents` remained `0`; a PaymentIntent reference was stored only on the private payment record.
- The temporary backend/listener were stopped; the disposable database, the initial failed disposable schema, and temporary logs containing the ephemeral signing secret were deleted. Staging and production were untouched.

An initial schema-scoped migration attempt exposed the repository's historical fixed `legacy_2025` archive-schema collision. The proof did not delete or modify that shared archive; it switched to a fully disposable database, where all 11 migrations applied successfully.

## Browser QA

The local dispatcher page was exercised with the isolated locked fixture.

- Desktop at 1440px: payment panel visible, assignment action disabled, no horizontal document overflow and no application-origin console warnings/errors.
- Phone at 390px: payment panel visible, assignment action disabled, no horizontal document overflow and a 44px assignment control.
- Desktop evidence: `payment-gate-desktop.png`.
- Phone evidence: `payment-gate-mobile.png`.
- The 2026-09-04 section changes only authenticated backend APIs and persistence; it adds no rendered UI. New visual browser screenshots were therefore not applicable. The compiled HTTP proof covered the actual transport boundary, validation, guards and serialization.
- The customer payment return page was exercised for success and cancel states. Success copy says the payment was submitted but does not claim it succeeded; it explains that Stripe/webhook confirmation may still be in progress.
- The pending-payment booking view displayed `Continue to payment` at desktop and 390px widths. The action was 50px high, the phone layout had no horizontal overflow, and the copy explains that Stripe opens in a new tab while the booking page stays available for verified status.
- The operator payment panel displayed the trusted `$100.00` fixture, active-request state and human-readable verified event at desktop and 390px widths. The phone layout had no horizontal overflow and its disabled active-request control remained 44px high.

## Scope and Safety

- A separate Stripe sandbox-only exercise successfully completed connected-account onboarding and a $100 test Checkout payment. No live-mode payment, production secret configuration, or deployed webhook request occurred. The application HTTP proof still used an injected no-network Checkout provider.
- No production database migration, deployment, IAM change, billing action, real customer data change or real appointment mutation occurred.
- The pre-existing deletion of `firebase-debug.log` in the reused worktree remains uncommitted and outside APP-012.
- The original backend and governance checkouts retain their unrelated local changes; this work was isolated in dedicated APP-012 worktrees.

## Remaining APP-012 Work and Risk

- Add governed manual override/exception handling and final end-to-end customer payment status evidence.
- Configure persistent staging/production webhook endpoints and secrets only as part of an explicitly approved release workflow.
- The webhook transition slice and isolated Stripe CLI delivery proof are complete but not deployed; APP-012 remains unreleasable.

## Review Steps

1. Review payment request and signed customer recovery orchestration, privacy-safe projections and audits in `src/payments/payment-requests.service.ts` and `src/scheduling/scheduling.service.ts`.
2. Review the provider boundary in `src/payments/stripe-checkout.provider.ts`: Checkout must remain a direct contractor connected-account charge with no Signmons application fee.
3. Review `stripe-webhooks.controller.ts` and `stripe-webhooks.service.ts` for raw-body signature verification, account/tenant binding, idempotency, transition guards, and bounded audit storage.
4. Run backend gates: `npm run -s build && npm test -- --runInBand && npm run -s lint && npm run -s arch:check && npx prisma validate`.
5. Confirm APP-012 remains in `Now`; do not merge, apply the migration outside an isolated local schema, configure Stripe or deploy without owner approval.

## Completion Estimate

- APP-012: approximately 80% complete (payment gate, payment requests and operator controls, signed/idempotent webhook transitions and bounded visibility, isolated sandbox delivery proof, and customer recovery/status UI complete; governed exceptions, persistent endpoint configuration, final acceptance and release remain).
- Governed CallDesk APP-006 through APP-016 sequence: approximately 65% complete (APP-006 through APP-011 released, plus five implemented APP-012 slices; release acceptance remains the governing measure).
