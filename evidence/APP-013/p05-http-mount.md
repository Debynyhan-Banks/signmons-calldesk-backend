# P05 disabled HTTP mount — 2026-09-13

Source backend 352c49d/governance 4a5d929. Owner requested continuation; pre-code scope recorded in APP013_P05_SOURCE_CARD.md. Existing item 2, no new package or scope deviation.

## Change

main.ts mounts customerSessionHttp() before CORS and default body parsing with NO resource binding. Customer namespace requests receive a sanitized private 503; no provider/client/environment activation. Unrelated routes call next without reading the request stream. Nest rawBody:true is unchanged.

Optional server-owned binding supplies existing transport plus tenant/integration context. handleStream performs existing method/path/host/origin/context checks before reading bytes, then acquires the existing budget and applies the 16 KiB streaming bound/canonical JSON checks. The middleware uses actual socket peer/TLS facts, never forwarded headers, and an eight-second socket inactivity timeout for configured requests. Upstream hard request/header limits and reviewed managed ingress remain deployment gates; inactivity timeout is not a total-duration guarantee. Error responses use existing sanitized no-store headers rather than relying on downstream Nest guards.

## Validation executed

- Seven new tests: six HTTP/mount cases plus streaming preflight/size case. Actual local HTTP verifies default refusal, explicit loopback success/server context, forged forwarded TLS refusal, unrelated webhook byte preservation and canonical JSON/origin refusal. Source test verifies closed mount precedes CORS with rawBody retained. Stream test verifies invalid ingress consumes zero body bytes and oversize refuses/releases budget.
- Build/lint passed; full unit tests: 119 suites passed, one skipped; 2,294 passed, three skipped.
- Architecture passed; full/production dependency audits: zero vulnerabilities.
- Existing disposable organization/database/browser regression passed and database cleanup completed. Supplemental artifacts /private/tmp/signmons-p05-http-evidence; log /private/tmp/signmons-p05-http-db.log. Existing pg concurrent-query warning non-failing. These are regression checks, not completed new P05 customer UI acceptance.
- Initial new-test setup incorrectly configured the disabled test's unused transport as non-fixture HTTP and closed a server twice; corrected test setup and reran full suite successfully. No application guard was weakened.
- Full governance/frozen baseline, all 21 governance regressions and both whitespace checks passed at closeout.

Commands: npm run build; npm run lint; npm test -- --runInBand; node scripts/architecture-check.mjs; npm audit --omit=dev; npm audit. Database/browser: ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-p05-http-evidence PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs.

## Review and remainder

Review customer-session-http.ts/.spec.ts, handleStream transport/spec and main.ts placement on existing PR21. Confirm unrelated webhook bytes are not consumed and the mount receives no live resources. This does not qualify Cloud Run forwarded headers or enable paid verification.

P05 local items 1–2 implemented; items 3 customer correction/exception/restart/created states and 4 connected desktop/mobile proof remain. P06 still owns exact managed-ingress/resource/config/release and live acceptance. No merge, deployment, migration, secrets/IAM, charges, customer changes or admin-panel implementation. Rollback/disabled state is absent binding; no fallback to legacy or unverified creation.

Accepted packages 3/60 (5%), walkthrough 3/8 (37.5%) unchanged; neither overall MVP percentage. Low-confidence 60–84 productive-day baseline unchanged. No complete-package timing sample.
