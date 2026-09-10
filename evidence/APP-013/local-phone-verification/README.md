# APP-013 local phone verification flow — 2026-09-10

## Outcome and limits

Customer can request a fictional code, enter it, explicitly resend when allowed, and clear prior proof to correct their phone in the existing local intake page. A lost verification response can be retried exactly without another attempt/write. Encrypted state survives service reconstruction; real database locks, shared destination budgets and atomic audits protect concurrent operations.

This is a deterministic FIXTURE ONLY adapter using test code 123456. It does NOT demonstrate access to a real phone. Responses label FIXTURE_VERIFIED and keep phoneAccessAuthorized, bookingAuthorized and deliveryAuthorized false. No job verification flags change. No customer identity, consent, mailbox verification, address/coverage, payment or booking authority is inferred.

The transport exposes the optional phone port only with explicit fixtureLoopback; service has no module/controller/provider registration. No SDK/package/schema/migration/config changes. No real sends, provider calls, account changes, billing/charges, real data, merge or deployment. Original dirty checkouts preserved.

## Files and contract

- src/communications/local-customer-phone.service.ts: request/check/clear/status, exact input keys, verified customer session and active tenant lock, encrypted Conversation.collectedData.localPhone state, same-transaction audit. Related collectedData keys are preserved.
- src/communications/local-customer-phone.service.spec.ts: 18 tests covering validation, attempts, expiry, replay, correction, rollback and no authority/privacy.
- customer-consent-browser-transport.ts and customer-consent-browser-budget.ts: optional local phone operation retains existing origin, credential, content-type, request-size, peer and request-budget boundary.
- scripts/fixtures/customer-intake-journey.html/js: optional local code controls; readonly bound phone until explicit successful clear; uncertain outcome retains exact request, private clear removes state; code field cleared after acknowledged response.
- scripts/verify-local-phone.mjs and verify-browser-review-admission.mjs: disposable database and real browser proofs.

Exactly six keys: action, code, expectedRevision, operationId UUID, phone, sessionToken. Action request/check/clear/status; canonical plus-country-code phone required for request/check; check code exactly six digits. Server derives tenant/conversation/session from credential. Check must match the challenge phone. A stale revision or changed last-operation retry refuses; exact latest retry returns current status, never expired success. Status is read-only. Clear revokes challenge/proof but does not reset abuse budgets. No admission transfer in this section.

Local QA policy (NOT approved production/provider policy): challenge 5 minutes, simulated proof 10 minutes capped by session expiry, resend cooldown 30 seconds; max 3 requests and 5 checks per session; per-tenant/destination max 3 requests and 5 checks across sessions in rolling 1 hour. Destination budget uses keyed digest, PostgreSQL advisory lock and audit counts; no raw phone/code in audits. Fixed code is deliberately public fixture data. Production phone normalization, key lifecycle, distributed edge budgets, expiry/retention and provider-owned challenge semantics remain review gates.

## Validation

- Backend full suite: 86 passed suites; 1616 tests passed, 3 existing tests skipped; 18 new tests.
- Backend lint/build, architecture check, Prisma validate and git diff checks passed.
- UI lint, 170 tests and static build passed.
- Backend and UI full/production dependency audits: four zero-vulnerability results.
- Local database: ten proof groups in phone-database-summary.json, including concurrent exact request, reconstructed-service retry, encrypted persistence, real audit rollback, revocation, cross-session request/attempt limits, cooldown, expired-code and forged-session refusal.
- Browser: request, wrong code, correct code with deliberately lost acknowledgment and byte-identical retry, mobile/desktop screenshots, explicit change revokes proof, no storage and zero page errors. Parent organization/admission/booking proof retained (12 organization + 8 admission + 13 browser groups).
- Temporary database cleaned up; calldesk_org_% query returned no rows.
- Initial sandbox test run could not bind sockets; approved local-socket rerun passed. Initial database proof exposed PostgreSQL void result decoding for advisory lock; changed to SELECT 1 FROM lock, final proof passed. Existing Next toolchain/PostCSS and pg concurrent-query deprecation notices remain. No process-kill, actual delivery or production-auth acceptance claim.

## Reproduce and review

From this focused backend, run npm run lint, npm run build, npm test -- --runInBand, npm run arch:check, npx prisma validate; UI: npm run lint, npm test, npm run build. Local HTTP tests need socket access.

With disposable local PostgreSQL on /tmp and existing Playwright installed:
```sh
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-phone-proof-20260910 PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
```
Verifier refuses non-fixture/non-Unix-socket database and removes its randomly named database in finally. It opens only loopback pages and fictional records.

Inspect phone-fixture-mobile.png / phone-fixture-desktop.png for code entry, explicit simulation labels and no authority. Inspect phone-database-summary.json and browser-review-summary.json for checks. Review that localPhone is not consumed by booking readiness or admission and that live transport remains inactive.

## Next and progress

Stop at review. Next needed is a separately bounded real verification provider contract/selection and activation plan, including actual code delivery/check semantics, limits, costs and channel behavior; no activation implicit. Then replace the simulation with authoritative evidence and explicitly connect admission. Address autocomplete/validation and coverage are separate outstanding connections. Existing human-reviewed job admission is unchanged, not a completed self-service booking experience.

APP-013 stays sole Now, Next empty, FE-014 paused. Recorded APP-013 scope coverage 50% / acceptance 0 of 12; onboarding 50% local / 0 of 6 accepted; pilot 0 of 12 accepted. No new formal acceptance credit or overall engineering ETA.
