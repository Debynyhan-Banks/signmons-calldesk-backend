# APP-013 / 2B / P06 runtime loader checkpoint

2026-09-14. Continues approved runtime card from backend 67923b3 / governance 7974319. No scope deviation. Implementation/local synthetic proof only; no live release or package acceptance.

## Changes

- controlled-intake-runtime.ts/spec builds one explicit service set per call and returns a frozen binding plus irreversible local retire. Missing/false envelope remains absent. Invalid enabled configuration refuses before resources; current database approval checked before injected secret material is used. No environment loader, Secret Manager call, listener or main registration added.
- ACTIVE tenant settings.controlledRuntimeApproval must contain exactly enabled:true and the envelope digest. Shared tenant lock and database clock bind current packet expiry. This is a required reader only, not an approval writer. Startup and phone proof use actual organization/payment/category authority; final admission reuses the actual current reader. Approval revocation refuses before body admission. Business policy checks stay inside controlled composition so its existing replay-first behavior is not moved behind a new organization-policy precheck; revoking runtime approval disables all new HTTP requests including replay.
- Exact injected reference set, 32-byte session/digest/fingerprint keys and Twilio token shape required; duplicate key bytes refused and temporary copies zeroized. Cipher is the separately provided existing encryption service: independence from its key and real secret provisioning remain release-review responsibilities. Google quota project is explicitly signmons, matching the existing transport; other projects refused.
- Actual consent response/capture/organization continuation, fingerprint, controlled intake, durable verification, provider adapters and PostgreSQL shared budget are composed. No fixture ports. Provider construction dispatches no calls. Controlled session close remains unavailable until its connected lifecycle work; main remains unbound.
- Fixed controlled-customer-verification.ts to supply new opt-in only for START, never CHECK. The real loader test exposed the prior adapter/core mismatch (CHECK returned 409); the durable safeguard was retained and the unit expectation tightened.

## Validation

- Full Jest 127 suites passed, one skipped; 2,338 tests passed, three skipped. Build, lint, architecture, Prisma schema and both npm audits passed (zero audit findings).
- Guarded disposable database test uses actual current approval/organization reader and loaded services. Missing approval, duplicate injected key bytes and malformed token refuse. Successful startup dispatches nothing; protected session START and durable phone START/CHECK dispatch exactly two synthetic SDK calls. Revoked approval and local retire refuse without further calls; settings restored in finally and parent disposable database removed.
- Complete existing PostgreSQL/390/1440 browser suite passed, including immutable consent/job binding, rollback, shared-budget independent-process/restart and phone-liability checks. No live provider calls. Existing non-failing pg concurrent-query deprecation warning remains.
- Loader test uses transport directly with server context; existing browser suite still prepares phone proof separately. This is not yet the browser-driven loaded-runtime phone-to-job acceptance test.
- Logs: /private/tmp/signmons-p06-loader-{build,lint,tests,db}.log. Browser/database artifacts: /private/tmp/signmons-p06-loader-evidence.

## Review and next observable result

Review controlled-intake-runtime.ts startup refusal/current approval checks, key copying, reader/provider composition, controlled CHECK mapping and scripts/verify-controlled-runtime.mjs. Run all card commands and confirm main.ts still has an unbound customerSessionHttp() mount. No production migration, real key access/configuration, billing, sending, deployment or main merge.

Remaining existing wiring: controlled session close, actual same-page phone-code/draft/address/job journey using loaded binding, and default-disabled startup/asset registration. Then the separately approved release packet and capped run/owner closeout. Same three remaining P06 items, no new package.

Accepted remains 5/60 (8.3%); walkthrough 3/8 (37.5%). Provisional 4–8 weeks at 25–30 collaborative hours/week plus external waits remains low confidence; next timing review at ten accepted packages.
