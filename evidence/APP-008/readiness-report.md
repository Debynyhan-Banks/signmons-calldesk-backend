# APP-008 Dispatch Assignment Board Readiness Report

Date: 2026-08-31

## Delivered contract

- Private operator route: `/app/dispatch`.
- Tenant-scoped API routes:
  - `GET /jobs/dispatch-board`
  - `GET /jobs/dispatch-board/:jobId`
  - `POST /jobs/:jobId/assignments`
  - `POST /jobs/:jobId/assignments/cancel`
  - `POST /jobs/:jobId/escalations`
- Queue filters and metrics cover new requests, ready-to-assign, assigned and escalated jobs.
- Assignment detail presents a deterministic technician recommendation and bounded operator-facing rationale before mutation.
- Authorized dispatchers can assign, reassign, cancel an assignment or use the existing escalation path.
- Non-recommended or unavailable technician overrides require a normalized reason.
- Optimistic concurrency uses `expectedUpdatedAt` to reject stale writes.
- Assignment mutations create tenant-scoped audit records and preserve the cross-tenant not-found boundary.
- The operator surface excludes customer contact details from the disconnected and queue-summary states.

## Acceptance evidence

| Acceptance criterion | Evidence |
| --- | --- |
| Assign and reassign jobs | Dispatch service tests cover initial assignment and replacement of an existing assignment. |
| Recommendation shown before assignment | Detail API and responsive UI expose the selected candidate, bounded reason codes and recommendation rationale. |
| Authorized manual override | RBAC guard and override-reason validation fail closed; browser QA confirmed the reason control. |
| Assignment audit history | Assignment and cancellation paths persist privacy-safe audit actions and metadata. |
| Tenant and RBAC enforcement | Authentication, `TenantGuard`, `DispatchAccessGuard` and repository tenant predicates are covered by tests. |
| Concurrent update protection | A stale `expectedUpdatedAt` value returns a conflict without mutating the job. |

## Quality gates

- Backend production build: passed.
- Backend tests: 19 suites passed and 1 skipped; 139 tests passed and 3 skipped.
- Backend architecture check: passed.
- APP-008 backend files passed focused ESLint.
- Repository-wide backend lint retains two pre-existing test-only findings in `src/config/env.validation.spec.ts` and `src/logging/call-log.service.spec.ts`; APP-008 did not modify either file.
- Operator UI lint: passed.
- Operator UI tests: 8 passed across intake, urgency and dispatch helpers.
- Operator UI production build: passed; `/app/dispatch` prerendered successfully.
- Browser QA passed at 390 px, 820 px and 1440 px without horizontal overflow or console errors.

## Deployment evidence

Released to the Signmons CallDesk environment on 2026-08-31.

- Feature commit: `c5b1816` (`feat(app): implement APP-008 dispatch assignment board`).
- Main merge: `d8de259` (GitHub pull request #7).
- Cloud Build ID: `5dca0dd5-3c59-4968-b19b-d6e1bdee23d6` (`SUCCESS`).
- Container: `us-east5-docker.pkg.dev/signmons/signmons/signmons-calldesk-backend:d8de259`.
- Container digest: `sha256:75390ba81bc7f83eace6e0d373e764a0a321199838735bd736de292e3eba946c`.
- Cloud Run revision: `signmons-calldesk-staging-00020-m2m`, serving 100% of traffic.
- Service URL: `https://signmons-calldesk-staging-845074063310.us-east5.run.app`.
- Operator console: `https://signmons-calldesk.web.app/app/dispatch`.
- No database migration was required; APP-008 uses existing assignment fields.
- Live readiness returned `200` with `status: ok`.
- An unauthenticated dispatch-board request returned the expected sanitized `401` response.
- Production CORS preflight returned `204` and allowed `https://signmons-calldesk.web.app`.
- Chrome release verification confirmed the hosted route, metrics, filters, operator authentication boundary and privacy-safe disconnected state.

## Build-identity lockdown

The dedicated `signmons-build@signmons.iam.gserviceaccount.com` identity was enabled only for this build. Temporary Cloud Logging writer, Artifact Registry writer, build-bucket reader and build-object viewer grants were removed immediately after deployment. Verification returned `disabled: true`, no project role, zero build-bucket matches and zero repository matches.
