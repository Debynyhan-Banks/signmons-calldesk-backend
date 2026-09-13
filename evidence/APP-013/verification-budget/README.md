# APP-013 approved verification budget and opt-in — 2026-09-10

## Outcome and approved policy

Owner approved the proposed $50 USD monthly phone-verification ceiling per organization, internal $25/$40 alerts, and separately approved increases for higher volume. This is an internal MVP safeguard, not a customer fee, subscription entitlement, profitability guarantee or permission to spend. Review actual usage, conversion and subscription economics after the first pilot month.

One bounded implementation connects a new inactive VerificationBudgetAdmission to DurableVerificationService. Missing admission implementation refuses. Production modules, routes, UI, packages and schema are unchanged; no provider configuration, sending, spending, billing or real records changed.

Changed code: src/communications/verification-budget-admission.ts and its spec; src/communications/durable-verification.service.ts and its spec; scripts/verify-durable-verification.mjs. Backend board and governance pointer/handoff/board/ticket/contracts/MVP/economics document the checkpoint.

## Contract and invariants

- Existing six-field operation input is unchanged; execute additionally accepts optional optIn {requested:true, noticeVersion}. START requires matching trusted fixture notice configuration. Request digest includes these consent fields; old no-consent receipt digests stay readable, but a new CHECK without a budget/consent reservation refuses.
- An injected VerificationAdmission port acquires a tenant-wide PostgreSQL advisory lock before the existing conversation lock. START reserves in the same transaction as operation state/audit, before the mocked adapter call. A transaction rollback removes both; exact replay does not create a second reservation.
- The trusted, snapshotted policy is explicitly FIXTURE_ONLY, tenant-scoped, and contains notice version/text/Terms/Privacy URLs and a fictional versioned whole-flow upper bound. Missing/invalid/zero/fractional pricing refuses. No published price is silently treated as a complete quote.
- Audit action conversation.verification_budget_reserved is the temporary local durable reservation ledger. It binds tenant, conversation, session, keyed exact-phone digest, start operation, server request timestamp, notice copy, rate version, USD integer micro-units, HELD state, $50 ceiling and crossed $25/$40 thresholds. No phone, code or bearer token enters the record.
- CHECK must find exactly one held, same-session/same-phone start reservation. The existing durable service limits the entire flow to one START and five CHECKs; checks consume the already-reserved flow, not another budget reservation. No resend support is inferred.
- Competing sessions serialize against the same organization's held balance. Whole-flow admission refuses when the next reservation would exceed $50. Exactly $50 is allowed; subsequent starts refuse. Pending, timeout, failed finalization and observed success never silently release cost.
- USD micro-units and UTC month labels are local implementation conventions. Every reservation remains unresolved in this slice, including prior-month entries. Therefore no automatic month reset replenishes this model: reconciliation/settlement is unfinished, and the safeguard intentionally becomes restrictive until that exists. It is not a finished recurring monthly accounting system.
- Alerts are durable threshold-crossing records, NOT delivered notifications. No override UI or live rate/configuration source is implemented. Thresholds and initial ceiling are the approved fixed defaults in this proof.
- Audit-backed state requires a dedicated retention/migration and production integrity plan before activation; do not delete/archive reservation rows to free budget. More than 10,000 rows or invalid stored amounts refuse conservatively.
- Provider APPROVED remains evidence only; phoneAccessAuthorized, bookingAuthorized and deliveryAuthorized remain false. No production legal-consent acceptance or browser notice presentation is claimed.

## Validation

- 22 new unit cases (20 budget policy, two durable admission/refusal/replay); full backend 89 passing suites, 1698 passing tests, three existing skips.
- Backend build, lint, architecture check, Prisma validate and git diff --check passed. Initial test-mock lint typing was corrected; final lint passed.
- Full and production-only backend audits: zero vulnerabilities.
- Fourteen real disposable-PostgreSQL proof groups recorded in durable-verification-summary.json, retaining the prior nine and adding budget race, rollback/deduplication, uncertainty/cap, thresholds and missing/stale consent.
- Two competing fictional $30 flow reservations: exactly one commits below the $50 ceiling. Setup reservation removed only from the disposable test database before the integrated proof.
- Integrated proof uses deliberately fictional $25 flow estimates: two mocked starts reserve $50; finalization failure retains its reservation; the next start refuses. Mock SDK starts 2/checks 1, live calls 0.
- Existing browser regression passed: 12 organization groups, eight admission groups, 13 browser groups and prior local-phone proof. No new UI changed; standalone UI tests/build were not rerun, and this is not a new end-user verification demonstration.
- Disposable database cleanup completed; local query for calldesk_org_% databases returned no rows. Existing pg concurrent-query deprecation warning remains. No process-kill or production-scale proof.
- Governance docs-consistency-check passed.

## Exact review steps

On codex/app-013-transactional-messaging, review the incremental diff from 1bac47f to this checkpoint. Confirm the budget lock precedes the conversation lock, reservation shares the first transaction, provider invocation remains outside it, and the second transaction never refunds uncertainty.

Run:

```sh
npm run lint
npm run build
npm test -- --runInBand
npm run arch:check
npx prisma validate
npm audit
npm audit --omit=dev
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-verification-budget-proof-20260910 PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
```

Local HTTP/database/browser tests need socket permission. The verifier uses only a random calldesk_org_* Unix-socket database and cleans it afterward; no provider credentials required. In governance run node scripts/docs-consistency-check.mjs.

## Next and progress

Stop for review. Next bounded outcome is the local customer journey connection: display explicit verification notice/request, exercise mocked consent/start/check and budget-refusal states, retain safe uncertainty/correction behavior and never imply a live code was sent. Do not drift into another unrelated hardening section.

Live activation additionally needs approved real rate/account/service binding, reconciliation/retention, short-term abuse controls, alert delivery, recovery and separately approved capped tests. Address/coverage and application proof transfer remain unfinished. Actual budget changes and higher limits require approval.

APP-013 sole Now; Next empty; FE-014 paused. APP-013 50% recorded scope coverage / 0 of 12 accepted; onboarding 50% local / 0 of 6 accepted; pilot 0 of 12 accepted, not 0% built. No defensible overall engineering percentage or ETA.
