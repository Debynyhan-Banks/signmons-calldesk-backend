# P02 — disabled controlled service authority

Review-ready, not deployed or customer-capability accepted. Existing APP-013 / 2B only. Approved source contract: governance APP013_P01_ENGINEERING_CONTRACT.md at 506b9a2; backend entry 8a4ef28. Owner accepted P01 and began P02 on 2026-09-13. Both origins fetched and focused worktrees used; unrelated saved checkout changes preserved. No scope deviation.

## Implemented / remaining

- Added controlled-intake-authority.ts and its specification: exact v1 server activation validation; private instance-owned object capability; strict tenant/integration/origin/category binding; current organization/payment approval timestamps and digests; database-clock validity; absent/disabled/revoked/mismatched authority refuses.
- Every check calls the injected trusted transaction-state reader, then checks activation again after the asynchronous read. There is no positive authorization cache. A forged role, copied object, serialized capability or capability issued by another instance cannot authorize. Read failures return a generic refusal.
- Result contains only deterministic internal actor/policy/packet metadata. It is neither customer authentication nor phone/address proof nor a job-write permit by itself. No provider payloads, credentials, logs or writes added.
- Local composition only: no controller, module registration, configuration loader, secret or environment activation added. Existing operator guards and fixture paths are unchanged. Default construction refuses. Disabling configuration invalidates issued capabilities on their next check.
- Remaining already planned integration: P03 trusted current proof reads, P04 actual transaction reader/locks and atomic job writer, P05 customer/ingress wiring. The caller must acquire the required locks and use database time immediately before writing; these unit tests use an injected state reader and do NOT prove real database locking or live policy enforcement. P06 separately approves actual resources, migration/release, cap/window and live proof.

## Validation reproduced this run

- 47 new authority tests: strict missing/extra/malformed configuration, immutable copied categories, valid actor, repeated state reads, forged/cross-instance capabilities, scope isolation, stale/inactive policy/category/tenant, expiry boundaries, absent state, future approval, revocation before/during read, sanitized failure.
- npm run build: passed with locked Prisma 7.10.0 client generation.
- npm run lint: passed after correcting require-await in test fixtures; initial lint failure was not a product failure and is not hidden as a first-pass success.
- npm test -- --runInBand: 113 suites passed, 1 skipped; 2,198 tests passed, 3 skipped. Skips remain skips, not acceptance.
- node scripts/architecture-check.mjs: passed.
- npm audit and npm audit --omit=dev: zero vulnerabilities reported at this run; this does not close non-dependency operational risks.
- Governance frozen baseline, complete cross-repository docs consistency and 21 governance regression tests passed; backend cross-repository guard and both git diff --check passed.
- Database migration/browser QA: not applicable to this unregistered, no-schema/no-UI primitive. No live database or provider invoked. Integrated database/race/browser proof remains mandatory in P03–P06; no old browser result is claimed as current.

## Timing and status

UTC start 2026-09-13 14:01:15; implementation/validation/document reconciliation checkpoint 14:08:43: **7 minutes 28 seconds elapsed** before final evidence and Git closeout. This is agent wall time, includes validation waits, and is not measured human focused effort or a full productive day. No external blocking or owner waiting during this interval. Subsequent owner review time is separate. P01's earlier planning duration was not measured, so no exact comparison is claimed.

P01 D (owner accepted); P02 R (this review pending). Remaining-plan accepted packages 1/60, not whole-app completion. Customer walkthrough stays 3/8 (37.5%). Keep the 60–84 productive-day Release A planning baseline unchanged pending at least five measured packages; no extrapolation from one short helper implementation. Next P03, no new section or denominator.

## Review / rollback

1. Review the two source files and this evidence in backend PR21, focusing on default refusal and current-state checks, not live readiness.
2. Re-run npm test -- --runInBand controlled-intake-authority and the full commands above from the focused backend worktree; use SIGNMONS_GOVERNANCE_REPO=/private/tmp/signmons-2b-bootstrap-gov for the backend guard and SIGNMONS_BACKEND_REPO=/private/tmp/signmons-2b-bootstrap-backend for governance consistency.
3. Review coordinated governance pointer/handoff/card and MVP_DAILY_DELIVERY_PLAN.md: P02 R, P03 next, unchanged frozen criteria. Accepting this code does not authorize deployment or a paid test.

Rollback is leaving this class unregistered/disabled or reverting the focused code commit before any future integration. No runtime traffic was changed; no production rollback is necessary. No merge, deployment, provider configuration, messages, charges or customer records changed.
