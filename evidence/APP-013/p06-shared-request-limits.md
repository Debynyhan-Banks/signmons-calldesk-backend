# P06 shared PostgreSQL request limits

Owner authorized shared database-backed limits under APP013_P06_RUNTIME_WIRING_CARD.md. Source checkpoint backend 3905e1d/governance f927e93; fetched clean focused branches. This bounded implementation is HTTP request admission only, NOT phone monetary liability admission or P06 completion. No scope deviation.

## Implementation and boundaries

SharedCustomerBrowserBudget uses existing AuditLog for append-only reserve/start/session/release events and a PostgreSQL transaction advisory lock keyed by packet. Policy requires explicit packet/tenant IDs, database-time validity up to 15 minutes, and total/tenant/session/start/in-flight limits (bounded at 1,000). One packet binds one tenant; total is packet-global, NOT a platform-wide or billing-account ceiling. Policy digest rejects changed limits/tenant/window on the same packet. No schema/migration or process-memory counter. Fixed packet totals do not reset every minute.

Transport awaits global admission before reading body. After credential validation it binds the real internal session ID and enforces session count before invoking the endpoint. Peer/forwarded IP is not a shared-budget key. Release is awaited/caught; it releases only in-flight capacity, not consumed request/start/session counts. Crashes and failed releases retain slots; expired packets admit nothing. Opaque IDs/policy digest only; no request bodies, phone, OTP, tokens or provider content in events. Existing retention rules apply; no audit cleanup/delete introduced.

Default runtime remains unbound; this adapter creates no clients/providers or deployment authority. The future reviewed loader must inject exact approved policy and prevent unapproved packet creation. Provider-spend reservation remains a separate pending P06 seam.

## Validation

Build/lint/architecture passed. Full Jest: 2,324 passed, 3 skipped; 123 suites passed, one skipped. Prisma schema valid; full and production npm audits zero vulnerabilities. New tests cover absent/malformed policy, database failure, contained release failure, authenticated async binding/refusal before endpoint invocation. Existing transport/body and full backend tests remain green.

Guarded disposable PostgreSQL harness executes four independent Node workers against the same packet: exactly one start admitted. Worker exits without release to model process loss. Reconstructed instances retain start and in-flight limits; release is idempotent; session cap and changed-session binding refuse; completed requests consume packet total; policy change and expired packet refuse. Private proxy text absent from audit. Existing connected 390/1440 database/browser journey rerun; synthetic provider ports only. Initial database probe caught an unsupported void-returning lock query and safely admitted zero; corrected query returns an integer projection. Failed run is not acceptance evidence.

Commands: npm run build; npm run lint; npm test -- --runInBand; node scripts/architecture-check.mjs; npx prisma validate; npm audit --omit=dev; npm audit; ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-p06-shared-evidence PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs. Logs /private/tmp/signmons-p06-shared-tests.log and /private/tmp/signmons-p06-shared-db.log. Parent harness cleans its disposable database. No new UI change; existing browser regression, not a new live phone-to-job demonstration. Existing pg concurrent-query deprecation warning remains nonfatal. Governance frozen/full consistency/21 regressions and whitespace gates at closeout.

## Review and remaining work

Review shared-customer-browser-budget.ts locking/counts/expiry, transport async admission and authenticated session binding, and verify-shared-browser-budget.mjs four-process crash/restart assertions. Re-run only guarded local harness. Rollback remains absent runtime adapter; no live setting changed. Remaining P06 item 2: controlled phone monetary admission, immutable runtime loader/managed ingress and actual browser START/CHECK-to-job proof. Release/capped run/closeout remain separately gated items 3/4.

Accepted packages 5/60 (8.3%), walkthrough 3/8 (37.5%), unchanged; not overall MVP percentage. Provisional remaining estimate 4–8 weeks at 25–30 collaborative hours/week plus external waits, low confidence. No extra accepted package for this component. No merge to main, deployment, cloud write, production migration, IAM/secrets, provider charges, real data or external actions.
