# APP-013 durable verification operations — 2026-09-10

## Outcome and files

Implemented one inactive persistence connection around the existing Verify adapter. Customer-session-scoped operations reserve before invocation and finalize afterward; no database transaction spans the adapter call. Exact operation replay returns the stored observation or unresolved reservation, never invokes again. New service instances use the same encrypted ledger.

Files: src/communications/durable-verification.service.ts, its spec, scripts/verify-durable-verification.mjs and the existing browser-verifier composition. No production module/controller/route, schema/migration/package, provider configuration or UI change. All provider calls in proof are mocked through the existing adapter. Existing deterministic local phone UI remains separate.

## Exact contract and conservative boundary

execute accepts exactly sessionToken, operationId UUID, kind START/CHECK, canonical phone, code and startOperationId. START requires empty code/reference; CHECK requires six digits and a prior start ID. Caller cannot choose the provider SID; CHECK derives it from a finalized PENDING start in the same session with the same phone digest.

One START and at most five CHECK operations are supported per session in this bounded local model, not an approved production traffic policy. Changed same-ID payload refuses; input and adapter result are snapshotted. New operations refuse while a reservation or UNKNOWN outcome is unresolved, or after approval. No resend/correction/recovery authorization is inferred.

Shared customer-session locks and active-tenant/ongoing-conversation checks protect both transactions. Conversation.collectedData.verificationOperations stores a versioned encrypted bounded ledger; other fields are preserved. Each entry has a keyed request digest (including code without storing plaintext), keyed phone digest, kind, start reference, random physical attempt ID, reservation time and nullable sanitized result. Credentials are not stored. Audits omit phone/code.

Reservation audit and state write are atomic. A failed reservation cannot reach the adapter. Finalization and observation audit are also atomic. If finalization fails, the reservation remains UNCONFIRMED with unknown invocation count and UNRECONCILED billing. It is never reclaimed automatically: a process could have stopped before or after a provider side effect. This prioritizes no duplicate invocation; customer-visible recovery remains unfinished.

Provider APPROVED remains an observation, not current phone-access proof: phoneAccessAuthorized, bookingAuthorized and deliveryAuthorized stay false. Receipt replay is historical and only available while the original customer session remains valid/ongoing. Closed/expired sessions cannot use this API to recover the result. No admission or job-verification flags change.

## Cost observations, not a billing system

Reserve and observe events share operationId and attemptId. Count one physical attempt, not two audit events. Unconfirmed reservations are potential costs with sdkInvocations:null, never silently zero. Finalized adapter output retains 0/1 invocation observation and NOT_ATTEMPTED/UNRECONCILED billing. No price, currency, invoice total, savings or profitability result is fabricated.

Per-provider account/service configuration fingerprint, rate-card version and actual invoice/usage reconciliation are still needed before live cost attribution. Shared production traffic limits, OTP opt-in evidence and a spend circuit breaker remain activation prerequisites. No new prices, billing policy, charges or real customer records.

## Validation

- 18 new unit tests; full backend 1676 passed, 3 existing skipped, 88 passing suites.
- Lint, build, architecture check, Prisma validation and diff checks pass.
- Full/production backend dependency audits both zero findings.
- Nine real disposable PostgreSQL proof groups in durable-verification-summary.json: committed reservation visible before mocked SDK call; concurrent pending replay; reconstructed-service final replay without writes; bound check and no authority; changed retry refusal; ledger/audit privacy; reservation rollback; finalization rollback with preserved potential cost; forged session refusal.
- Mock SDK calls: two starts and one check; live provider calls zero.
- Existing browser regression retained and passed: 12 organization, eight admission, 13 browser groups, plus prior ten local phone database groups. New durable behavior is a service/database proof, not a new customer UI or live verification demonstration.
- Disposable database removed; cleanup query returned no calldesk_org_% databases. Existing pg concurrent-query deprecation remains. No process-kill test or automatic reconciliation claim.
- No UI source changed; standalone UI tests/build were not rerun. Prior UI evidence is not new acceptance.
- Initial TypeScript narrowing after input snapshot required explicit validated string casts; final build passes.

## Reproduce / review

Run npm run lint, npm run build, npm test -- --runInBand, npm run arch:check and npx prisma validate. Full HTTP suite needs local socket permission.

For disposable DB and browser proof:
```sh
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-durable-verify-proof-20260910 PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
```
Verifier requires a randomly named calldesk_org_* database on the local Unix socket and cleans it up. No provider secrets/recipients needed.

Review that failed finalization leaves a reservation, replay does not increment calls/cost observations, changed input cannot reuse the ID, and no result grants booking or sends. Inspect production modules for absence of DurableVerificationService.

## Next / progress

Stop for review. Next bounded need: verification admission prerequisites for durable OTP-request opt-in and usage-budget authorization, still mocked and inactive. Actual monetary caps need approved rate inputs and budget; do not substitute the six-entry local ledger limit. Customer uncertainty/correction recovery, provider binding/versioning, live approval, real proof transfer and address/coverage remain open.

APP-013 sole Now, Next empty, FE-014 paused. APP-013 50% recorded scope / 0 of 12 accepted; onboarding 50% local / 0 of 6 accepted; pilot 0 of 12 accepted. No overall engineering ETA or acceptance increment.
