# APP-012 Payment Gate And Payment Request Checkpoints

Date: 2026-09-04
Branch: `codex/app-012-payment-gate`
Ticket: `APP-012` payment gate and webhook status workflow
Checkpoint: bounded payment-before-dispatch gate plus authenticated payment-request API; review-ready, not released

## Outcome

These checkpoints implement two bounded APP-012 vertical slices. A shared, provider-independent policy derives whether payment is required from the job's tenant-policy snapshot. Required jobs remain locked until canonical payment state `SUCCEEDED`; the backend prevents new assignment and the dispatcher UI explains the lock. An authenticated backend API can now create and track the required contractor-to-customer checkout request without exposing provider identifiers.

APP-012 remains in `Now`. Stripe webhook verification/processing, operator/customer recovery surfaces, complete payment-event visibility and release work remain later APP-012 sections.

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

## Automated Evidence

### Backend

- Focused new payment-request tests: 2 suites, 12 tests passed; combined payment policy/request tests: 3 suites, 20 tests passed.
- Full tests: 26 suites and 189 tests passed; 1 suite/3 tests skipped by the existing database-test policy.
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

### Frontend

- `npm run -s lint`: passed with no warnings or errors.
- `npm test -- --runInBand`: passed, 4 suites and 17 tests.
- `npm run -s build`: passed; `/app/dispatch` exported successfully.

## Local HTTP Proof

An isolated `calldesk_test` tenant/job/payment fixture was created after applying the two already-committed local test-schema migrations. No staging or production database was accessed.

- Pending required payment: list response returned `queue: NEW_REQUEST`, `state: LOCKED`, `paymentStatus: PENDING` and `reasonCode: PAYMENT_PENDING`.
- Assignment attempt: HTTP `409`; database verification showed the job remained unassigned and assignment-audit count remained `0`.
- Simulated successful canonical payment state: detail response returned `queue: READY_TO_ASSIGN`, `state: UNLOCKED`, `reasonCode: PAYMENT_SUCCEEDED`, one eligible candidate and a `dispatch-v2` recommendation.
- The isolated tenant was deleted after verification; cascade cleanup returned the fixture count to `0`.

This proof validates gate consumption only. It does not claim that webhook ingestion is implemented or verified.

The payment-request section was then exercised through the compiled Nest application with an overridden no-network Checkout provider and a disposable PostgreSQL schema:

- All 11 committed migrations, including `20260904100000_add_payment_request_tracking`, applied successfully.
- Authenticated create, exact replay and tracking requests returned HTTP `201`, `201` and `200`.
- The payment persisted as `PENDING` for `12500` cents with `applicationFeeAmountCents=0` and a stored Checkout session reference.
- The exact replay invoked the idempotent provider boundary but left exactly one `payment.request_created` audit.
- API responses exposed neither the provider Checkout session nor PaymentIntent identifier.
- The local fixture was cascade-deleted and the disposable schema `calldesk_app012_20260904a` was dropped after proof.

## Browser QA

The local dispatcher page was exercised with the isolated locked fixture.

- Desktop at 1440px: payment panel visible, assignment action disabled, no horizontal document overflow and no application-origin console warnings/errors.
- Phone at 390px: payment panel visible, assignment action disabled, no horizontal document overflow and a 44px assignment control.
- Desktop evidence: `payment-gate-desktop.png`.
- Phone evidence: `payment-gate-mobile.png`.
- The 2026-09-04 section changes only authenticated backend APIs and persistence; it adds no rendered UI. New visual browser screenshots were therefore not applicable. The compiled HTTP proof covered the actual transport boundary, validation, guards and serialization.

## Scope and Safety

- No real Stripe API call, secret configuration or webhook request occurred; Checkout behavior used an injected no-network provider during proof.
- No production database migration, deployment, IAM change, billing action, real customer data change or real appointment mutation occurred.
- The pre-existing deletion of `firebase-debug.log` in the reused worktree remains uncommitted and outside APP-012.
- The original backend and governance checkouts retain their unrelated local changes; this work was isolated in dedicated APP-012 worktrees.

## Remaining APP-012 Work and Risk

- Implement signature-verified, idempotent webhook event handling and visible processing results.
- Add secure customer status/recovery actions and an operator payment-request surface.
- Persist and audit payment/gate transitions, including failed/expired/refunded/canceled outcomes and any governed manual override.
- Add full operator webhook-event visibility and end-to-end customer payment status evidence.
- The current gate trusts the canonical `Payment.status`; until signed webhook ingestion is delivered, APP-012 is not releasable.

## Review Steps

1. Review the payment request orchestration, privacy-safe projection and audits in `src/payments/payment-requests.service.ts`.
2. Review the provider boundary in `src/payments/stripe-checkout.provider.ts`: Checkout must remain a direct contractor connected-account charge with no Signmons application fee.
3. Review the migration and authenticated controller/guard paths, then review the existing gate reducer/UI screenshots under `evidence/APP-012/`.
4. Run backend gates: `npm run -s build && npm test -- --runInBand && npm run -s lint && npm run -s arch:check && npx prisma validate`.
5. Confirm APP-012 remains in `Now`; do not merge, apply the migration outside an isolated local schema, configure Stripe or deploy without owner approval.

## Completion Estimate

- APP-012: approximately 40% complete (payment-request tracking and payment-gate criteria implemented and evidenced; webhook, customer and complete transition-audit criteria remain).
- Governed CallDesk APP-006 through APP-016 sequence: approximately 58% complete (APP-006 through APP-011 released, plus two bounded APP-012 slices; release acceptance remains the governing measure).
