# Local customer submission and operator approval — 2026-09-10

Review-ready incremental section after c9b03b9 on PR #21. Customer browser submits its reviewed draft; a separate operator browser loads the opaque reference, reviews facts/current organization approval, selects urgency, acknowledges customer statements, and creates exactly one CREATED job. This closes the local browser admission connection, not production or full MVP acceptance.

## Changes and boundaries

- Inactive same-origin customer transport adds POST /customer-session/submit, exact keys and validated pending-only receipt, existing CSRF/credential/body/budget controls. Missing composition refuses. The existing fixture remains read-only unless the local proof explicitly enables data-review-submit.
- New CustomerIntakeReviewController delegates POST /intake-review-request/read and /approve under identity/tenant guards, sanitized errors and private/no-store responses. Deliberately absent from production modules. Throttle metadata is not a production rate-limit acceptance claim.
- Separate local operator HTML/JS uses an operator token in memory only, never the customer bearer. Neither page persists browser state. Lost acknowledgment preserves the exact submission/decision; no automatic retries/replacement. Changed, expired or closed requests refuse. Clearing/reloading is not revocation and loses retry state.
- Uses existing locked admission implementation without schema/package changes. Contact/address remain unverified. CREATED is not a booking, payment, dispatch or message; consent association is not send permission. No provider actions, production data/configuration, merge or deployment.

## Evidence and validation

browser-review-summary.json records five new browser groups. Screenshots show customer submission, operator review and mobile admission receipt. Actual Chromium/HTTP/Nest/services/PostgreSQL with explicit fixture identities, not production Firebase acceptance. Parent verifier also reruns 12 organization/intake groups and eight atomic admission groups. Its phases use the current approved fixture profile; this is deterministic FAQ/fallback, not live semantic AI. New phase creates one fictional job; prior admission phase creates three. All are removed with the disposable database; cleanup query returned no rows.

Backend: 82 passing suites, 1542 passing tests, three prior skips; lint/build/architecture/Prisma pass. UI: lint, 170 tests, 16-page static build pass. Four fresh full/production backend/UI npm audits: zero findings. Changed-script syntax/format and diff checks pass. Existing Next lint deprecation/multiple-lockfile and PostCSS test warnings remain non-blocking.

One concurrent regression run returned 401 instead of expected 503 in an existing Calendar HTTP test; a subsequent isolated full run passed. No Calendar code changed; cause is not established and intermittent test stability remains a review note. Initial browser harness interception did not preserve the intended request behavior; final proof injects response loss server-side after successful commits. One failed harness run needed explicit removal of its exact disposable database; subsequent runs clean up automatically. No new process-kill proof.

## Reproduce and review

From the focused backend worktree, with local PostgreSQL on /tmp:5432 and the installed Playwright runtime:

```sh
npm run lint
npm test -- --runInBand
npm run arch:check
npm run build
npx prisma validate
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-browser-review-proof-20260910 PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
psql -h /tmp -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'calldesk_org_%'"
```

Run UI lint/test/build in ui; run npm audit and npm audit --omit=dev in both roots. Review c9b03b9..HEAD, especially production-module absence, exact-request retries, explicit human decision and no booking/delivery authority. Inspect all three screenshots and browser-review-summary.json. The runner opens ephemeral local pages and closes them at completion; these are review fixtures, not a deployed customer portal. Governance placement/consistency checks must pass separately.

## Progress and next review

Local approved-information → customer submission → operator approval → one job is demonstrated. Onboarding remains 3/6 (50%) locally demonstrated / 0/6 formally accepted; APP-013 remains 50% recorded scope coverage / 0/12 formally accepted; pilot 0/12 accepted. These are distinct denominators, not overall engineering completion or an ETA.

Stop for review of this connected local journey. Next decision is acceptance of this local milestone and selection of the next existing MVP outcome—not automatic ticket promotion or another speculative hardening section. Production identity, shared rate limiting, key/retention/access controls, post-expiry/status recovery, approval-change recovery and version-2 old-reader rollout remain gates. APP-013 sole Now, Next empty, marketing paused; advisory sales and website import remain outside MVP.
