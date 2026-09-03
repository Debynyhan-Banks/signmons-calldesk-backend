# APP-012 Payment Gate Checkpoint

Date: 2026-09-03
Branch: `codex/app-012-payment-gate`
Ticket: `APP-012` payment gate and webhook status workflow
Checkpoint: bounded payment-before-dispatch gate; review-ready, not released

## Outcome

This checkpoint implements the first bounded APP-012 vertical slice. A shared, provider-independent policy now derives whether payment is required from the job's tenant-policy snapshot. Required jobs remain locked until the canonical payment state is `SUCCEEDED`; the backend prevents a new technician assignment and the dispatcher UI explains the lock.

APP-012 remains in `Now`. Payment-request creation, Stripe webhook verification/processing, customer recovery actions, complete payment-event visibility and release work remain later APP-012 sections.

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

## Automated Evidence

### Backend

- Focused payment/readiness/dispatch tests: 3 suites, 24 tests passed.
- Full tests: 24 suites and 175 tests passed; 1 suite/3 tests skipped by the existing database-test policy.
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

## Browser QA

The local dispatcher page was exercised with the isolated locked fixture.

- Desktop at 1440px: payment panel visible, assignment action disabled, no horizontal document overflow and no application-origin console warnings/errors.
- Phone at 390px: payment panel visible, assignment action disabled, no horizontal document overflow and a 44px assignment control.
- Desktop evidence: `payment-gate-desktop.png`.
- Phone evidence: `payment-gate-mobile.png`.

## Scope and Safety

- No Stripe API call, secret configuration, checkout creation or webhook request occurred.
- No production database migration, deployment, IAM change, billing action, real customer data change or real appointment mutation occurred.
- The pre-existing deletion of `firebase-debug.log` in the reused worktree remains uncommitted and outside APP-012.
- The original backend and governance checkouts retain their unrelated local changes; this work was isolated in dedicated APP-012 worktrees.

## Remaining APP-012 Work and Risk

- Define and implement payment/deposit request creation and secure customer status/recovery actions.
- Implement server-side Stripe checkout and signature-verified, idempotent webhook event handling.
- Persist and audit payment/gate transitions, including failed/expired/refunded/canceled outcomes and any governed manual override.
- Add full operator webhook-event visibility and end-to-end customer payment status evidence.
- The current gate trusts the canonical `Payment.status`; until signed webhook ingestion is delivered, APP-012 is not releasable.

## Review Steps

1. Review the shared reducer and fail-closed dispatch checks in `src/payments/payment-gate.policy.ts` and `src/jobs/dispatch-board.service.ts`.
2. Review the locked-state UI and screenshots under `evidence/APP-012/`.
3. Run backend gates: `npm run -s build && npm test -- --runInBand && npm run -s lint && npm run -s arch:check`.
4. Run frontend gates from `ui`: `npm run -s lint && npm test -- --runInBand && npm run -s build`.
5. Confirm APP-012 remains in `Now`; do not merge, migrate or deploy without owner approval.

## Completion Estimate

- APP-012: approximately 20% complete (1 of 5 ticket acceptance criteria implemented and evidenced).
- Governed CallDesk APP-006 through APP-016 sequence: approximately 56% complete (APP-006 through APP-011 released, plus this bounded APP-012 slice; release acceptance remains the governing measure).
