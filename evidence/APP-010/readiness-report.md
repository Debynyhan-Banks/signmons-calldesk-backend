# APP-010 Readiness Report

Date: 2026-09-02
Branch: `codex/app-010-routing`
Status: review ready; not merged or deployed

## Delivered

- Tenant-scoped routing rule create/update APIs with deterministic priority.
- Active ZIP service-area create/update APIs and dispatch enforcement.
- Technician availability, on-call and service-capability controls.
- Business-hours/after-hours evaluation in the tenant timezone.
- Emergency owner/administrator and on-call escalation paths.
- `routing-v1` reason trace embedded in `dispatch-v2` recommendations and assignment audits.
- Explicit audit-logged routing evaluation action.
- Responsive `/app/routing` operator control center and routing trace in `/app/dispatch`.
- Prisma migration for `RoutingRule` and technician `isOnCall` state.
- Uniform not-found handling for missing and cross-tenant routing-rule and service-area updates.
- Boundary validation that rejects whitespace-only routing-rule and service-area names.

## Acceptance Evidence

| Criterion | Evidence |
| --- | --- |
| Tenant can create/update routing and escalation rules | `POST /jobs/routing/rules`, `POST /jobs/routing/rules/:ruleId`; operator UI form |
| Service area and availability constraints are enforced | `RoutingService.evaluateJob`; candidate eligibility in `DispatchBoardService`; out-of-area unit test |
| Emergency rules support owner + on-call escalation | `RoutingService` escalation target query and emergency escalation unit test |
| Recommendation reason is visible | `routing-v1` panel in `/app/dispatch` with rule, coverage, factors and escalation path |
| Rule evaluations are audit logged | `routing.rule_evaluated`; exact trace also embedded in assignment audit metadata |

## Automated Gates

- Backend build: passed
- Backend lint: passed
- Backend tests: 162 passed across 24 suites
- Architecture check: passed
- Prisma validation: passed
- Production dependency audit at the critical threshold: passed with no critical advisories; 4 high and 8 moderate transitive advisories remain documented below
- UI production build: passed; `/app/routing` generated
- UI lint: passed with no warnings
- UI tests: 14 passed across 4 suites
- Governance consistency check: passed against the current APP-010 pointer and documentation worktree

## Visual QA

- Desktop viewport: passed; forms, metrics, policy list and technician controls maintain hierarchy.
- Phone viewport (390 x 844): passed; panels collapse to one column, controls remain readable and touch-safe.
- Authentication-disabled state is clear and prevents unsafe writes.
- `/app/routing` and `/app/dispatch` both rendered without application-origin console errors or horizontal document overflow.

## Continuation Validation Section

- Reconciled the backend and governance repositories with their remotes before work began.
- Audited the implementation against the canonical APP-010 data contract and confirmed the active pointer remained APP-010.
- Added focused regressions for the missing/cross-tenant update boundary and normalized required names.
- Re-ran the backend, UI, Prisma, architecture, governance and responsive-browser gates from the focused branch.
- No merge, migration, deployment, IAM, secret, billing or real-customer action was performed.

## Known Review Risk

- `npm audit --omit=dev --audit-level=critical` exits successfully with no critical advisories, but reports `4` high and `8` moderate transitive advisories through Prisma and Firebase dependencies. The suggested automated remediations are breaking major-version changes, so dependency migration is intentionally not bundled into APP-010 hardening.

## Release Requirements

1. Owner review and approval of this branch.
2. Merge the focused APP-010 commit.
3. Run the new Prisma migration in the release workflow.
4. Deploy backend and Firebase-hosted UI.
5. Configure one real service area, rule and on-call technician, then run a real tenant acceptance test.

The pre-existing deletion of `.github/instructions/snyk_rules.instructions.md` was not included in APP-010 work and must remain outside the APP-010 commit.
