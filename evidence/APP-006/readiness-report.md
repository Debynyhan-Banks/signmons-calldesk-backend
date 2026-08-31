# APP-006 Intake Review Readiness Report

Date: 2026-08-31

## Delivered contract

- Private operator route: `/app/intake-review`.
- Tenant-scoped API routes:
  - `GET /jobs/intake-review`
  - `GET /jobs/intake-review/:jobId`
  - `POST /jobs/:jobId/readiness/review`
- Server-side roles: `owner`, `admin`, and `dispatcher`; all other roles fail closed.
- Required-field assessment covers customer name, phone, service address, service category, issue summary, urgency, preferred window, and required-deposit status.
- Photos are optional and appear as customer attachment links when present.
- Emergency and governed high-priority requests are visibly flagged.
- Conversation trace is loaded from the tenant-bound intake session using retained, redacted message payloads.
- Readiness reviews create a PII-free `AuditLog` entry containing only state and missing-field identifiers. Reviewing does not assign, mutate, or complete the job.

## Acceptance evidence

| Acceptance criterion                      | Evidence                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Required values or explicit missing flags | `IntakeReadinessService` returns `READY_TO_ASSIGN` or `MISSING_INFO` with the exact missing-field list; the UI presents each missing item. |
| Clear booking readiness                   | Queue badges, metrics, detail panel, and readiness summary use the same server-computed state.                                             |
| Emergency/high-priority visibility        | `priority` is returned by the API and rendered in the queue plus a detail alert.                                                           |
| Tenant and role enforcement               | `RequestAuthGuard`, `TenantGuard`, and `IntakeReviewAccessGuard`; tests cover allowed and rejected roles plus tenant-scoped queries.       |
| Auditable decisions                       | `POST /jobs/:jobId/readiness/review` records `job.intake_readiness_reviewed`; the detail response returns recent review history.           |

## Missing-field scenario proof

`src/jobs/intake-readiness.service.spec.ts` verifies a request with an unknown caller, placeholder phone/address, blank service category, no issue summary, no preferred window, and an unpaid required deposit. The result is `MISSING_INFO` with all seven applicable missing-field identifiers.

## Quality gates

- Backend build: passed.
- Backend tests: 15 suites passed, 1 skipped; 111 tests passed, 3 skipped.
- Architecture check: passed.
- APP-006 focused backend lint: passed.
- Repository-wide backend lint: two pre-existing test-only findings remain in `src/config/env.validation.spec.ts` and `src/logging/call-log.service.spec.ts`; neither file was changed by APP-006.
- Operator UI lint: passed.
- Operator UI tests: 2 passed.
- Operator UI production build: passed; `/app/intake-review` prerendered successfully.
- Chrome console errors: none during local desktop/mobile verification.

## Visual evidence

- `intake-review-desktop.png` — Chrome at 1440 × 1000.
- `intake-review-mobile.png` — Chrome at 390 × 844.

The screenshots intentionally show the disconnected state. No production credentials or customer data were placed in browser evidence.

## Deployment status

Implementation is verified locally and is not yet deployed. Deployment requires an explicit release action and production operator authentication configuration.
