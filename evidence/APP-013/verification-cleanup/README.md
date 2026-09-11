# Section 1B — cleanup/restart evidence

2026-09-11. Parent backend 4c5030a; governance 9a90b7e. Both focused remote branches fetched/aligned before work. Owner accepted 1A with “proceed” and approved this section and ninety-day resolved-reference retention with “yes”. Section 2/8 locally demonstrated; 1/8 accepted. No whole-MVP completion claim.

## Implemented boundary

- Protected session creation persists original fifteen-minute expiry. Shared locks refuse malformed, expired or closed lifecycle. Closure commits before purge; audit/purge failure leaves proof unusable and deletion retryable.
- Inactive fixture-owned startup/periodic worker sweeps bounded explicit-tenant batches without browser tokens. Submitted review/job business payloads and consent remain. Only matching abandoned draft content and verification-only payloads are removed at session expiry/closure, earlier than seven days. Event envelopes and unrelated/foreign-session content remain.
- Correction cache has separate session ownership, maximum 64 entries, signed expiry/24-hour ceiling, periodic closed-session checks and in-flight fencing. Reconstruction has no candidates and cannot redispatch an observed operation.
- Ninety-day purge removes only retry aliases for safely cancelled, never-dispatched address operations whose hold is zero, using authoritative cancellation audit time. Core operation/accounting rows, counters, audits and unresolved holds remain. No phone settlement or blanket accounting retention is invented.
- Optional loopback-only end route supports exact retry after a lost acknowledgment. Busy/unconfirmed local clearing truthfully leaves server expiry in charge. No production scheduler, migration or provider activation.

## Validation observed

- Backend: 98 suites / 1,869 tests passed; one suite / three existing tests skipped. Build, lint and architecture passed.
- UI: 170 tests, lint and static production build passed.
- Prisma validate passed; schema unchanged. Backend full/production and UI full/production npm audits each reported zero findings.
- Twelve new disposable PostgreSQL cleanup proof groups passed, including concurrent purge, audit rollback/retry, session isolation, service reconstruction, expired-snapshot reintroduction and retained accounting. See database-summary.json.
- Full organization/customer/operator parent regression passed, including original address/freshness flows and mobile/desktop closure with lost-acknowledgment retry. See browser-summary.json. Actual 390px and 1280px closure screenshots inspected: cleared inputs, visible truthful closure, no overflow. No live providers were called.
- Independent PostgreSQL query returned [] for calldesk_org_ databases after teardown. Only fictional fixture payloads/aliases were deleted; the disposable database was dropped. No real customer records were touched.
- Existing pg concurrent-query deprecation and Next workspace-root/lint-tool warnings remain. Early browser runs exposed outdated immediate-clear assertions and a local fixture request-window limit; assertions now wait for acknowledged closure and independent browser scenarios reset only the local request limiter, never durable spend holds. Final full run passed.

## Reproduce and review

From the focused backend checkout:

```sh
npm run build
npm run lint
npm run arch:check
npm test -- --runInBand
npx prisma validate
npm --prefix ui test
npm --prefix ui run lint
npm --prefix ui run build
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-1b-review PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
```

Requires disposable local PostgreSQL on the Unix socket and installed Playwright. The parent creates/migrates/drops only a random calldesk_org_ fixture database. Review verification-cleanup-summary.json and verification-journey-summary.json in the output directory, then cleanup-closed-mobile.png and cleanup-closed-desktop.png. Final observed artifacts: /private/tmp/signmons-1b-final-20260911 (ephemeral, not a production evidence store).

Review closure-before-purge and held-cost assertions, verify submitted payloads remain, and confirm the ninety-day rule is only supported cancellation aliases. Then accept 1B and separately approve 2A current-proof admission. No later section was started.

## Remaining gates

Production scheduler/distributed ownership, legacy-record migration and real retention/source qualification are not activated. Restore evidence is service reconstruction and an expired snapshot simulation, not a full database backup/restore drill or backup-media deletion. Live county/phone/address qualification, payment/calendar/SMS actions and release remain approval-gated. APP-013 scope index stays 50%, accepted 0/12; onboarding local 50%, accepted 0/6; pilot accepted 0/12. No defensible overall effort percentage or calendar ETA.
