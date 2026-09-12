# APP-013 phone-only execution connection — 2026-09-12

Owner reviewed the phone-only readiness packet and approved implementation. This checkpoint adds code, not live activation. APP-013/2B remains Now; 3/8 walkthrough milestones accepted (37.5%), not overall MVP completion.

## Implementation and limits

Registered POST /communications/staging-phone-test/operations and /stop behind RequestAuthGuard and TenantGuard. Operations accept { operation, optIn? }; operation uses the existing exact six-field durable START/CHECK contract. Responses are private/no-store; the route filter does not log or echo errors, credentials or OTPs. Server checks exact owner/admin identity, tenant, session, conversation and keyed participant digest; impersonation and dev-auth mode refuse. No public session-issuance or approval-enabling endpoint was added.

STAGING_PHONE_TEST_ENABLED must explicitly equal true (string), K_SERVICE must be signmons-calldesk-staging and GOOGLE_CLOUD_PROJECT must be signmons. STAGING_PHONE_TEST_POLICY is a strict, versioned JSON deployment input; missing/invalid input disables execution. Separate STAGING_PHONE_SESSION_KEY and STAGING_PHONE_DIGEST_KEY are 32-byte hexadecimal values; STAGING_PHONE_TWILIO_AUTH_TOKEN is required only for an enabled operation. No existing secrets are repurposed or fallback credentials used. No actual values configured this turn.

Policy fields: version=1, tenantId, operatorId, sessionId, conversationId, accountSid, serviceSid, phoneDigest, startsAt/expiresAt (epoch milliseconds, at most 30 minutes), rateVersion, flowUpperBoundMicros and noticeVersion. The bound must conservatively cover the complete one-START/up-to-five-CHECK flow including applicable fees. The matching TenantOrganization.settings.stagingPhoneTestApproval must be { enabled: true, digest: stagingPhoneDigest(policy) }. This requires separately approved private configuration; HTTP callers cannot supply policy or enable it.

One START per session and at most five CHECKs reuse DurableVerificationService. An account-scoped PostgreSQL advisory lock serializes reservation; all retained staging phone holds across tenants and dates count against three total STARTs and USD 0.50. Each approved session still permits only one START. No automatic resets, refunds or retries. Approval is rechecked under a tenant SHARE lock at reservation and immediately around SDK dispatch; stop updates that row and waits for prior SHARE locks. Stop acknowledgement prevents subsequent dispatch, but cannot recall a request already in flight. Database/transport uncertainty remains held and unreplayed. Exact replay requires the original qualified staging hold, preventing fixture receipts from acquiring staging qualification.

TwilioVerifyAdapter is reused with SMS, riskCheck=enable, autoRetry=false, maxRetries=0 and eight-second SDK timeout. No address, job, payment, calendar or confirmation component is invoked. Phone/job/booking/delivery/payment/address authority remains false even after provider APPROVED. No freshness/admission proof issuer is connected.

## Validation

- Build, lint, architecture check and Prisma validation passed.
- Full Jest: 2,069 passed, three existing skips; 109 passing suites, one skipped.
- Production dependency audit: zero vulnerabilities.
- Local HTTP tests: disabled authenticated requests, unauthorized refusal, malformed-body rejection, sanitized no-store responses; test authentication substitute is not Firebase acceptance.
- Disposable local PostgreSQL harness: shared-account concurrency cap, duplicate request/replay, one START, successful CHECK without downstream authority, retained unknown liability, expiry, stop versus in-flight request, and unqualified replay refusal. Existing 30 address-ledger/execution groups also passed. All SDK calls substituted in-process; no network provider traffic. Disposable database removed in finally.
- Whitespace and governance consistency/regressions required at commit. No UI changed; responsive browser QA is not applicable. HTTP behavior was exercised over localhost, not claimed as browser/real-account acceptance.

## Review and remaining release gates

Review staging-phone policy/admission/service/controller, the additive durable replay hook, and both test files. Reproduce with npm run build; npm run lint; npm run arch:check; npx prisma validate; npm test -- --runInBand; npm audit --omit=dev; node scripts/verify-staging-address-reservation.mjs (local disposable PostgreSQL only).

Next is a bounded read-only release/configuration packet: exact reviewed image/revision, existing isolated tenant/session preparation and encrypted retention policy, Firebase operator, private owner phone, effective US-only Verify geography/Fraud Guard, approved notice and consent, account-specific conservative fee bound and UTC window. A +1 prefix does not itself establish a US recipient; confirm the allowlisted recipient is US and the provider geography restriction is effective. The cap bounds this application path, not unrelated Twilio traffic or the account invoice. Do not issue/commit a session token in chat or source control.

Then obtain explicit configuration/deployment and capped-send authorization. Google responseId retention and county qualification still block full 2B admission, but not this isolated phone subtest. No deployment, provider call, configuration/secret/IAM change, production migration, charge, merge or customer action occurred.
