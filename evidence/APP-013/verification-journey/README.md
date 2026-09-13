# APP-013 local customer verification journey — 2026-09-10

## Review-ready outcome

The existing local customer intake page now has an optional durable verification demonstration: server-provided notice, explicit unchecked request acknowledgment for the displayed number, mocked START/CHECK through the existing adapter and durable consent/budget services, uncertainty/exact retry, correction invalidation and budget-refusal messages that retain draft details.

No real text is sent or real phone access proved. All application authority remains false. No production module/controller registration, provider configuration, schema/migration/package change, real customer data, billing, charges, merge or deployment.

Changed files: local-verification-browser.service.ts and spec; customer-consent-browser-transport.ts and spec; customer-consent-browser-budget.ts; scripts/fixtures/customer-intake-journey.html and .js; scripts/verify-browser-verification.mjs; parent scripts/verify-browser-review-admission.mjs; backend execution board and this evidence. Related governance pointer, handoff, board, ticket, MVP and contracts record the checkpoint.

## Boundary

Optional POST /customer-session/verify is available only through explicit fixtureLoopback binding and an injected verification port. It reuses origin, Fetch Metadata, custom header, tenant/session, byte and local request-budget checks. Its exact eight fields are sessionToken, action, operationId, phone, code, startOperationId, requested, noticeVersion. NOTICE requires empty operation/phone/code/reference/version and requested:false. START requires requested:true and the exact fixture notice version. CHECK cannot replace consent and references the saved START logical ID, never a customer-selected provider SID.

LocalVerificationBrowserService exposes only notice or sanitized operationId/state/outcome and false-authority flags, not attempt IDs, costs, provider SIDs or session credentials. It refuses upstream authority-bearing receipts. Notice content comes from the same exported constant used in the test budget configuration. The Terms/Privacy URLs are explicitly example.test placeholders, not approved production legal pages. This is not legal-consent or live-delivery acceptance.

Browser input stays in memory only, never URL/storage. Editing the number before requesting resets acknowledgment. Unknown network or durable outcomes freeze the exact pending request for explicit retry; no automatic new START. Saved approval retry calls the provider once. Code input is cleared after a valid receipt; pending data remains in memory only as needed for exact retry. Clear/pagehide/expiry abort and clear local private state, not saved server records.

After a request, explicit number correction removes the local verification claim and disables replacement verification in that session. It does not revoke or refund historical provider/consent records; no current application proof exists. Full replacement/resend/recovery is not implemented. A 400/409/429 verification refusal retains draft details; the generic message does not leak an organization's balance or claim every refusal is specifically a budget issue.

The $50 ceiling/$25 and $40 thresholds remain the approved policy. Boundary proof uses a clearly fictional $25 whole-flow estimate; it is not a real SMS price. Reservations remain HELD, including unknown outcomes. Reconciliation, monthly replenishment, delivered alerts and approved overrides remain unfinished.

## Validation

- Full backend: 90 passing suites, 1709 tests passed, three existing skips; 11 new unit cases.
- Backend lint/build, architecture, Prisma validation, fixture JavaScript syntax and diff checks passed.
- Backend full/production-only dependency audits: zero findings.
- Seven new browser/database proof groups in verification-journey-summary.json. Real local session, durable ledger, budget admission and injected Verify adapter; the surrounding conversation reply is explicitly scripted.
- Wrong code then correct code; lost approval response exact retry is byte-identical and does not repeat SDK call. Phone edit resets acknowledgment, later correction removes local claim. Unknown second START holds its budget and exact replay does not invoke again. Third START at the $50 reserved ceiling refuses while retaining the draft.
- This helper used two mocked START calls, two mocked CHECK calls, zero live provider calls and zero new jobs. Parent regression still includes its existing one fictional CREATED job; do not report the entire parent run as zero jobs.
- Parent regression passed: 12 organization, eight admission, 13 prior browser groups, local-phone proof and fourteen durable-budget database groups.
- Desktop and 390px mobile screenshots visually inspected. Improved new-panel whitespace and label placement after first visual review; final browser run passed. No overflow, page errors or browser storage.
- Disposable PostgreSQL database removed; cleanup query returned no calldesk_org_% databases. Existing pg concurrent-query deprecation remains.
- Standalone application UI build/test not rerun: only backend-owned HTML/JS fixtures changed; actual fixture browser QA covers this change. No production identity, process-kill or end-user verification acceptance claim.

## Exact review

Review a0fae29..HEAD on codex/app-013-transactional-messaging. Inspect the screenshots and summary here. Reproduce:

```sh
npm run lint
npm run build
npm test -- --runInBand
npm run arch:check
npx prisma validate
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-verification-journey-proof-20260910 PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
```

Requires local socket/browser permission. The verifier creates only a randomly named calldesk_org_* database over /tmp and cleans it afterward. No provider secrets required. No persistent preview server is left running. Governance: node scripts/docs-consistency-check.mjs.

Review notice/unchecked consent, code result with explicit no-real-authority text, and draft-preserving refusal. Verify the two identical approval requests result in only one physical CHECK, and no code/retry claims a booking or send.

## Next / completion

Stop for owner review of this connected customer experience. Next proposed MVP section: inspect and map the existing address-validation and service-area evidence needed in the same journey, reusing current contracts; no provider setup or live calls. Phone live activation still requires real rate/account/service binding, legal notice approval, reconciliation/retention, shared abuse controls, recovery, alert delivery and separately approved capped testing. Application proof transfer remains open.

APP-013 sole Now; Next empty; FE-014 paused. APP-013 50% recorded scope coverage / 0 of 12 accepted; onboarding 50% local / 0 of 6 accepted; pilot 0 of 12 accepted, not 0% built. No defensible overall engineering percentage or ETA.
