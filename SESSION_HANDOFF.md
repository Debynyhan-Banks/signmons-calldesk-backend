# Backend Session Handoff

Last Updated: 2026-09-04

## Current Program Pointer

- Active ticket: `APP-012` payment gate and webhook status workflow.
- APP-011 is owner-approved, merged and released from PR `#13` at `28d394f`.
- Next ticket after APP-012: `APP-013` Twilio-backed notification center and transactional customer messaging.
- Keep the WIP limit at one and do not start APP-013 until APP-012 is accepted and released.

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
- APP-012 is approximately 40% complete; APP-006 through APP-016 is approximately 58% complete.

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

1. Review the APP-012 payment-gate and payment-request checkpoints; keep APP-012 in `Now` and unreleased.
2. In the next approved APP-012 section, implement signature-verified, idempotent webhook state transitions.
3. Keep Stripe secrets server-side and maintain the contractor-to-customer payment boundary; Signmons tenant pricing remains subscription-only.
4. Do not begin APP-013, merge, migrate or deploy without owner approval.

## Restart Commands

```bash
git status --short
npm run -s build
npm test -- --runInBand
npm run -s arch:check
cd ui && npm run -s lint && npm run -s build && npm test -- --runInBand
```
