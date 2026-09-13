# APP-013 inactive Twilio Verify adapter — 2026-09-10

## Outcome

Owner approved Twilio Verify and requested cost awareness. Implemented one inactive server-internal start/check adapter; no environment/secret loader, DI registration, route, database write, live SDK client or provider call. Tests inject mocks, including the installed real SDK with a replaced network-free HTTP client. Local phone fixture remains separate and unchanged.

Files: src/communications/twilio-verify.adapter.ts and twilio-verify.adapter.spec.ts. Only governance/evidence documentation changes otherwise.

## Contract

Trusted constructor binding: tenantId UUID, accountSid AC SID, serviceSid VA SID; defensively copied. Missing/invalid binding or factory returns UNAVAILABLE with no invocation. Foreign tenant refuses before client construction. Caller supplies operationId UUID and canonical phone; check also supplies stored verificationSid VE SID and six digits. Unknown/extra fields refuse before invocation.

Start maps only to verifications.create({to, channel:sms, riskCheck:enable}); check maps only to verificationChecks.create({verificationSid, code}). Factory receives autoRetry:false, maxRetries:0, timeout:8000, logLevel:error. The installed RequestClient defaults zero maxRetries to 3, so autoRetry:false is the effective disabling setting. The network-free real-SDK test verifies this behavior and wire form/URL. Future factory must honor these options; no production factory is included.

Response must match configured account/service, exact phone, sms channel and valid VE SID; check additionally requires exact requested SID. Only check status approved yields APPROVED. Pending, expired and terminal refusal are distinct. Start approval, malformed/foreign response, 404, transport errors and 5xx are UNKNOWN; 429 is RATE_LIMITED; selected explicit request/auth rejections are REFUSED. Raw errors, phone, code, provider payload and stack are not returned or logged. No inferred token expiry.

Every result keeps phoneAccessAuthorized, bookingAuthorized and deliveryAuthorized false: provider evidence still requires durable application finalization. No manual-approval endpoint, automatic retry, fallback or resend.

## Cost boundary

usage reports START/CHECK, SDK invocation count (0 or 1), and NOT_ATTEMPTED or UNRECONCILED billing. It is an observation for a future durable collector, not a billable-SMS counter, a provider invoice, price estimate or already-implemented spend cap. Invocation attempts with unknown/refused outcomes must not be priced as zero. No hardcoded rates, plan prices, fees or budgets in code.

The adapter is intentionally not idempotent storage: repeated caller invocation makes another SDK invocation. Caller must reserve/deduplicate and enforce opt-in, destination/peer budgets and a spend circuit breaker before invoking it. This requirement prevents treating client retry IDs as external exactly-once guarantees. See governance VERIFICATION_UNIT_ECONOMICS.md.

## Validation

- 42 new contract tests; full backend 87 passing suites, 1658 passed tests, 3 existing skips.
- Backend lint, build, architecture check, Prisma validation and git diff checks passed.
- Backend full and production-only dependency audits both zero findings.
- Real installed SDK exercised with injected HTTP result, zero network calls; typed SDK compatibility confirmed by build.
- Browser/UI/database QA not applicable to this unregistered adapter: no UI, route or persistence changes. Prior 170 UI tests/local-browser evidence not rerun and not claimed as new acceptance.
- Initial formatting issue fixed with ESLint. Initial real-SDK test caught zero retry-count normalization; corrected test documents effective autoRetry:false behavior. Final full suite passes.
- Original dirty backend/governance checkouts remain unchanged.

## Review / reproduce

Run npm test -- --runInBand twilio-verify.adapter.spec.ts, npm run lint, npm run build, npm run arch:check, npx prisma validate, and npm test -- --runInBand. Full HTTP suite needs approved local socket access; adapter tests themselves need no sockets/accounts.

Review exact mapping and response-binding cases, no code/phone in results, 404/timeout ambiguity and all false authority fields. Confirm production modules do not reference TwilioVerifyAdapter. No secrets or live recipients are needed.

Next bounded outcome: durable verification request reservation/finalization with deduplication and usage observations, tested with this adapter's mocked outcomes before live integration. Cost ledger/reconciliation, spend caps, OTP notice evidence, customer recovery, provider activation, admission proof transfer and address/coverage remain open. No billing/production changes authorized.

APP-013 remains sole Now; Next empty; FE-014 paused. Recorded APP-013 scope coverage 50% / 0 of 12 accepted; onboarding 50% local / 0 of 6 accepted; pilot 0 of 12 accepted. No overall engineering ETA.
