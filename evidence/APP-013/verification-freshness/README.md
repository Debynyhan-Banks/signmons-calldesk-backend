# Section 1A — mock verification freshness and invalidation

Owner approved section 1A and the thirty-minute proof lifetime after publishing the eight-section steel-thread plan. This is section 1 of 8, locally demonstrated and awaiting owner acceptance; accepted 0/8. APP-013 remains sole Now. Runtime parent cbe605f; branch parent 7b8a089. No cleanup/retention implementation, real-source acceptance or job admission in this section.

## Delivered

- Shared inactive freshness policy requires explicit FIXTURE_ONLY mode, thirty-minute lifetime and current notice/source/business-policy versions. Scope binds tenant/session and the respective phone/address revision. Checked, confirmed and expiry timestamps are validated; exact expiry/future clock and missing/changed scope/policy refuse. Earlier source/session expiry wins. The existing fifteen-minute protected session is unchanged, so it currently shortens the thirty-minute ceiling.
- Durable phone START captures policy; CHECK refuses changed policy before dispatch, and successful observation rechecks policy under the session lock before storing optional proof metadata in the existing encrypted ledger. Database epoch milliseconds avoid raw timestamp timezone decoding. Old approval receipts without proof never gain freshness on replay. Status/reconstruction reuses original timestamps, not a new check or budget reservation.
- New inactive freshness/revocation methods share the existing lock and audit transaction. Revocation nulls matching phone entries, fences in-flight CHECK completion and survives exact receipt replay. Audit failure rolls back. No settled/uncertain costs are released; one START/five CHECK restrictions remain. Expired/revoked proof does not authorize a replacement paid request.
- Existing fixture verify transport body is unchanged; STATUS/REVOKE require empty operation/code/start/notice fields and requested=false. They never invoke a provider. The customer page offers a no-code freshness check, truthfully displays current/expired state, waits for server phone-revocation acknowledgment before enabling edits and retains the draft. Real phone/booking/delivery authority stays false.
- Address correction requires current trusted policy, preserves the original successful preview check time and caps confirmation at thirty minutes/session end. Reconfirming never renews it. Exact address intent/revision and session still bind the candidate. The trusted port now compares session/current approved organization-policy binding, not unrelated conversation.updatedAt changes, so phone ledger writes do not revoke unchanged address confirmation. AddressVerified/admission/delivery remain false and county UNKNOWN.

## Files / boundaries

Domain: src/communications/verification-freshness.ts and spec. Existing durable-verification.service.ts, local-address-correction.ts/spec and local-verification-browser.service.ts/spec implement the inactive connections. Fixture composition: scripts/local-freshness-policy.mjs and local-correction-port.mjs. Existing customer-intake-journey.html/js and parent browser/correction scripts demonstrate the same flow; verify-verification-freshness.mjs adds real disposable PostgreSQL proof.

No Prisma schema/migration, package/lockfile, production module/controller registration, live client/provider configuration, IAM/secrets, billing, sending, real data or release changes. Optional encrypted-ledger fields require reviewed old-reader rollout before any activation; compatibility with already deployed old readers is not claimed. Production evidence/intent ownership, retryable cleanup/restore and retention remain 1B; atomic current-proof-to-job is 2A and qualified real sources are 2B. Ninety-day resolved-reference retention remains proposed, not implemented. No OS-process-kill or live provider timeout claim.

## Validation

- Backend: 97 passing suites, 1,855 passing tests; three existing skipped tests (one skipped suite). Twenty more passing tests than VO-2. Build, lint, architecture and Prisma validation passed.
- UI: 170 passing tests, lint and static build passed. Browser exercises current/expired proof, exact retry, server revocation, draft preservation and the parent customer/operator flow at 390×844 and 1280×900; no page errors, browser storage or horizontal overflow. Screenshots visually inspected.
- Thirteen new database proof groups: original/session-capped deadlines; no renewal/call on replay/reconstruction; phone/session isolation; address survives phone revocation and vice versa; sticky revocation; expired/legacy proof; missing/changed policy; real audit rollback; in-flight CHECK revocation race; policy changes during call and between START/CHECK; session closure; foreign tenant and missing-policy-before-dispatch refusal. Eleven fictional phone flow holds remain 110 micro-units; separate address hold stays 10. No real-price claim.
- Existing VO-1/VO-2 and full organization/customer/operator/browser parent regression passed. It includes pre-existing fictional jobs; the new 1A database proof creates zero jobs. All provider calls in these proofs are mocks. Parent-owned disposable databases removed; independent PostgreSQL check found no remaining calldesk_org_ databases.
- Backend full/production and UI full/production npm audits: four runs, zero findings. No dependency update. Existing pg concurrent-query deprecation, Next lint/workspace-root and source-map toolchain warnings remain. A new test formatting disagreement was corrected with the configured linter; final gates pass. Historical VO-2 Node exit 139 was not reproduced here and is not declared root-caused.

Committed database-summary.json and browser-summary.json are sanitized machine-readable evidence. Final artifact directory: /private/tmp/signmons-1a-accepted-policy-20260911 (name refers to policy approval, not section acceptance). Screenshots: freshness-expired-mobile.png, freshness-expired-desktop.png, verification-journey-mobile.png, verification-journey-desktop.png; parent correction images and summaries are in the same directory.

## Reproduce and owner review

```sh
npm run build
npm run lint
npm run arch:check
npx prisma validate
npm test -- --runInBand
npm --prefix ui test
npm --prefix ui run lint
npm --prefix ui run build
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-1a-review PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
```

Review the original deadline in database/browser summaries and current-proof screenshot. Confirm the expired screenshot retains the draft and offers no automatic resend. Inspect tests for expiry/policy/phone changes and in-flight revocation, plus original held accounting. Verify no production bootstrap or provider initialization was added. Accept 1A only after reviewing this evidence; next is 1B cleanup/restart with separately approved retention mapping/implementation. Eight-section baseline unchanged; no overall build percentage or ETA inferred.
