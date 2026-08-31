# BE-007 Tenant Lead-Source Reporting Readiness Report

Date: August 30, 2026

## Release identity

- Backend commit: `8264c74` (`feat(reports): add tenant lead-source summary`)
- Container: `us-east5-docker.pkg.dev/signmons/signmons/signmons-calldesk-backend:8264c74`
- Cloud Run service: `signmons-calldesk-staging`
- Revision: `signmons-calldesk-staging-00015-7hq`
- Traffic: 100 percent

## Contract and security proof

- Route: `GET /reports/lead-sources`
- Authentication: Firebase bearer token in production.
- Tenant source: verified request context only; no `tenantId` request field exists.
- Roles: owner, admin or manager.
- Date range: explicit ISO-8601 offsets, positive duration, maximum 366 days.
- Cache policy: `Cache-Control: private, no-store`.
- Prisma select is limited to `status`, `acceptedAt`, `completedAt` and `policySnapshot`; no customer, address, message, calendar or management-token fields are selected.
- Live unauthenticated request returned HTTP `401` with the sanitized public error body.
- Readiness health returned `{"status":"ok"}` after deployment.

## Automated gates

- Focused reporting suites: 2 passed, 13 tests.
- Full Jest run: 11 suites passed, 1 skipped integration suite; 80 tests passed, 3 skipped.
- Build: passed.
- Architecture check: passed.
- Focused ESLint for `src/reporting` and `src/app.module.ts`: passed.
- Repository-wide lint still reports two pre-existing test-file findings in `src/config/env.validation.spec.ts` and `src/logging/call-log.service.spec.ts`; neither file is part of BE-007 and lint is not a required backend completion gate.

## Production-safe aggregate proof

The August Eastern-month window was queried using only status/timestamps and attribution JSON. No customer PII was selected or displayed.

| Metric | Count |
| --- | ---: |
| Created jobs | 8 |
| Booked lineage | 5 |
| Completed | 0 |
| Cancelled | 1 |
| Attributed | 1 |
| Unattributed | 7 |

The attributed source group was `acceptance_test / website / job_attribution` with one job, matching the labeled production acceptance booking.

These figures are a technical pilot baseline, not a public performance claim. Seven earlier jobs predate the attribution release and correctly remain unattributed.

## Rollback

- Previous known-good revision: `signmons-calldesk-staging-00014-s2j`.
- Previous image: `us-east5-docker.pkg.dev/signmons/signmons/signmons-calldesk-backend:efe648f`.
- Rollback requires routing Cloud Run traffic back to the previous revision or redeploying the previous image; no database migration is involved in BE-007.
