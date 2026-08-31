# APP-007 Urgency Escalation Review Readiness Report

Date: 2026-08-31

## Delivered contract

- Private operator route: `/app/urgency-review`.
- Tenant-scoped API routes:
  - `GET /jobs/urgency-review`
  - `GET /jobs/urgency-review/:jobId`
  - `POST /jobs/:jobId/urgency/override`
  - `POST /jobs/:jobId/escalations`
- Canonical persisted urgency values: `EMERGENCY`, `HIGH`, and `STANDARD`; a database migration adds `HIGH` without rewriting existing jobs.
- Server-side roles: `owner`, `admin`, and `dispatcher`; all other roles fail closed.
- The queue returns job reference, service category, urgency, status, decision rationale and escalation path without customer contact information, address or transcript content.
- Overrides require a normalized 10-500 character reason. The job update and `job.urgency_overridden` audit entry commit in one transaction; same-value replays do not create duplicate audits.
- Operator escalations notify only configured internal operations recipients. Each attempt records `job.urgency_escalated` with privacy-safe channel and truthful `delivered`, `failed`, `misconfigured`, or `not_configured` outcomes.
- Repeated escalation clicks within five minutes reuse the latest recorded result instead of sending duplicate notifications.
- Rationale exposes bounded reason codes, source and an operator-facing confidence note—not hidden model reasoning or diagnostic certainty.

## Acceptance evidence

| Acceptance criterion | Evidence |
| --- | --- |
| All three urgency levels visible | The Prisma enum, AI intake DTO, intake persistence, APIs, filters, metrics and queue badges share `EMERGENCY`, `HIGH`, and `STANDARD`. |
| Explainable classification | `UrgencyReviewService` returns source, bounded reason codes, plain-language trigger details, confidence note and escalation-path preview. |
| Authorized override with reason | DTO validation, `UrgencyReviewAccessGuard`, transactional update and audit creation are covered by focused tests. |
| Escalation and override history | Detail API returns PII-safe override/escalation audit history; notification delivery outcomes are explicitly persisted. |
| Tenant and RBAC enforcement | Every route uses request authentication, `TenantGuard`, and `UrgencyReviewAccessGuard`; missing and cross-tenant jobs share the not-found boundary. |

## Quality gates

- Backend focused lint: passed for every APP-007 changed TypeScript file.
- Backend tests: 17 suites passed, 1 skipped; 127 tests passed, 3 skipped.
- Backend architecture check: passed.
- Backend production build: passed.
- Repository-wide backend lint still has two pre-existing test-only findings in `src/config/env.validation.spec.ts` and `src/logging/call-log.service.spec.ts`; APP-007 did not touch those files.
- Operator UI lint: passed.
- Operator UI tests: 5 passed across intake and urgency helpers.
- Operator UI production build: passed; `/app/urgency-review` prerendered successfully.
- Chrome visual QA: desktop and 390 × 844 mobile layouts rendered without horizontal document overflow or console errors.

## Visual evidence

- `urgency-review-desktop.png` — disconnected, privacy-safe desktop state.
- `urgency-review-mobile.png` — disconnected, privacy-safe mobile state.

No operator credential or customer data was placed in the screenshots.

## Deployment status

Implementation verified locally. Database migration, backend release and operator-console hosting release remain pending and require a separate deployment action.
