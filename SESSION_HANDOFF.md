# Backend Session Handoff

Last Updated: 2026-09-02

## Current Program Pointer

- Active ticket: `APP-012` payment gate and webhook status workflow.
- APP-011 is owner-approved, merged and released from PR `#13` at `28d394f`.
- Next ticket after APP-012: `APP-013` Twilio-backed notification center and transactional customer messaging.
- Keep the WIP limit at one and do not start APP-013 until APP-012 is accepted and released.

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

1. Reconcile the APP-012 ticket with the subscription-only product policy and Stripe payment-before-booking requirement.
2. Implement the payment gate, webhook-driven payment status and customer recovery states without charging per booked job.
3. Keep Stripe secrets server-side, enforce webhook signature verification and make fulfillment idempotent.
4. Run owner review before merge, migration or deployment.

## Restart Commands

```bash
git status --short
npm run -s build
npm test -- --runInBand
npm run -s arch:check
cd ui && npm run -s lint && npm run -s build && npm test -- --runInBand
```
