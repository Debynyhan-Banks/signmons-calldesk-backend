# APP-009 Technician Mobile Workflow Review Checkpoint

Date: 2026-09-01

Status: review-ready implementation checkpoint; APP-009 remains `Now` and is not released.

## Bounded section completed in this run

- Revalidated the existing APP-009 implementation at commit `01bc84a` on `codex/app-009-technician-workflow`.
- Made signed-link verification reject non-canonical base64url signature spellings in constant time so every textual signature mutation fails closed.
- Corrected PostgreSQL adapter schema selection so `TEST_DATABASE_URL?schema=calldesk_test` is honored by both raw SQL and Prisma model queries.
- Made the AI e2e suite load application configuration only after selecting the isolated test database and assert the active schema before exercising HTTP flows.
- Repaired the backend lint script so it covers all TypeScript files under `src/` with the installed ESLint version.
- No production migration, deployment, IAM, secret, billing, provider, customer, or appointment action was performed.

## Implemented APP-009 surface

- Technician PWA route: `/app/technician`.
- Signed-link endpoints:
  - `POST /jobs/technician-links/:technicianId`
  - `GET /technician/jobs`
  - `GET /technician/jobs/:jobId`
  - `POST /technician/jobs/:jobId/status`
- Supported technician actions: accept, decline, on my way, in progress, complete, and cannot take.
- The link token is held in the URL fragment, HMAC signed, tenant and technician scoped, time bounded, and revalidated against an active technician record.
- Job reads and mutations require the assigned technician and verified tenant on every query.
- Status writes use `expectedUpdatedAt` optimistic concurrency and emit tenant-scoped audit actions.
- Dispatcher detail consumes the same technician-status and audit lineage, so technician progress is visible to dispatch without a second state store.

## Objective validation

| Check | Result |
| --- | --- |
| Backend build | Passed. |
| Backend tests | 23 suites and 156 tests passed. |
| Backend architecture check | Passed. |
| Backend lint | Passed across `src/**/*.ts`. |
| UI production build | Passed; `/app/technician` prerendered successfully. |
| UI lint | Passed with no warnings or errors. |
| UI tests | 11 tests passed across 4 suites. |
| Isolated API integration | Assigned list `200`, detail `200`, accept update `200` with `technicianStatus: ACCEPTED`, expired link `401`. |
| Browser fail-closed QA | Missing-link route displayed the secure-link recovery message at 1280 x 720 with no console warnings/errors and no horizontal overflow. |
| Production dependency audit | No critical advisories; backend reports 3 high / 8 moderate and UI reports 2 high advisories that require separately reviewed breaking upgrades. |

Browser artifact: `technician-invalid-link-desktop.png`.

The in-app browser protected the signed credential once it appeared in the URL and blocked further automated interaction. Authenticated list/detail rendering is therefore covered by service, UI-helper, and isolated HTTP integration tests in this checkpoint; a human reviewer should capture the authenticated mobile list/detail view before APP-009 is marked `Done`.

## Remaining review and release work

1. From an isolated non-production database, issue a technician link through the authenticated dispatch workflow.
2. Open it at a mobile viewport and verify Today, Upcoming, Completed, detail fields, and action progression.
3. Confirm the dispatcher view reflects technician status and audit history after one test action.
4. Review and approve the APP-009 migration before any non-local execution.
5. Merge, migrate, deploy, and perform live safe checks only with explicit owner approval.

## Risks and estimate

- Signed links are bearer credentials. They must remain in the URL fragment and must not be copied into logs, analytics, screenshots, or support messages.
- The test fixture and local migration were confined to `calldesk_test` and removed after validation.
- Production dependency audit reports no critical findings, but backend has 3 high / 8 moderate and UI has 2 high advisories. Automated fixes propose breaking Prisma, Firebase Admin and Next.js upgrades, so remediation needs a separate approved compatibility ticket rather than an unreviewed force upgrade here.
- APP-009 ticket estimate: about 90% complete; authenticated mobile visual evidence and release approval remain.
- Approved APP-006 through APP-016 CallDesk sequence estimate: about 35% complete (APP-006, APP-007, and APP-008 released; APP-009 review-ready; APP-010 through APP-016 not started).
