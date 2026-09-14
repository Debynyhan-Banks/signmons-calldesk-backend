# APP-013 / 2B — Google correction-sequence repair

Owner approved the bounded repair and explicitly approved fail-safe refusal when short-lived sequence state is lost/expired. Source backend e3cd8fc / governance 6303ef8, existing focused branches and PR21; no saved-checkout changes. Governance card: APP013_GOOGLE_CORRECTION_CARD.md. No scope deviation, new package, county-fallback expansion or live authority.

## Implementation

Existing OAuth transport accepts only an optional UUID previousResponseId and omits it for initial requests. Composition owns a private volatile map, capped at 1,000 entries, with timer deletion at five minutes or session expiry. Only the first response UUID is held; follow-up consumes it once and cannot renew retention. Key binds tenant/session/conversation/category/policy/organization approval. Per-request intent/revision and current phone/policy/final-transaction guards remain intact. No provider ID reaches job/audit/browser/log/queue storage.

Existing durable operation count distinguishes a later operation from an initial one after cache/process loss. Missing state refuses before Google dispatch; reservation liability is conservatively retained and there is no cap refund or automatic fresh sequence. Another process without state also refuses. This is approved staging behavior, not seamless distributed recovery. Disabled main composition remains unchanged.

## Validation and observed correction

Initial connected run safely refused the corrected request because intentId is requestId and changes after correction. Stable authenticated session binding fixed this; the first failure preserved customer fields and created no job. Final tests exercise the actual existing browser/HTTP/composition/services/disposable PostgreSQL journey with synthetic provider I/O. Fetch assertions verify no previousResponseId on first call and the original UUID on follow-up; durable/browser assertions exclude that UUID.

Full Jest: 2,301 passed, 3 skipped; 120 suites passed, one skipped. Build/lint/architecture passed; production/full npm audits zero vulnerabilities. Full existing disposable database/browser harness passed, including eight connected scenarios at 390/1440: accepted with post-commit failed acknowledgment and exact replay, outside refusal, uncertainty, explicit correction then admission. Existing local UI unchanged. Mobile correction receipt visually inspected: legible, no booking/payment/dispatch/message authority. No actual phone/address request or provider charge.

Commands: `npm run build`; `npm run lint`; `npm test -- --runInBand`; `node scripts/architecture-check.mjs`; `npm audit --omit=dev`; `npm audit`; `SIGNMONS_GOVERNANCE_REPO=/private/tmp/signmons-2b-bootstrap-gov node scripts/check-governance-baseline.mjs`; `ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-google-correction-evidence PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs`. Governance frozen/full consistency, 21 regression tests, both whitespace checks required at closeout.

Local artifacts: /private/tmp/signmons-google-correction-unit.log, /private/tmp/signmons-google-correction-db.log, /private/tmp/signmons-google-correction-evidence/connected-correction-390.png and connected-correction-1440.png; parent harness cleans its disposable database. Existing pg concurrent-query deprecation warning remains nonfatal.

## Review / next checkpoint

Review request schema and volatile cache, follow-up refusal before dispatch, operation history binding and synthetic wire assertions. Re-run commands above without live credentials or activation. All four card items locally implemented/tested; owner review remains for this repair. P06 remains next planned capped staging activation packet; managed ingress/resources/caps/release approval and live proof remain separate. No merge/deploy/migration/IAM/secrets/provider setting or production action.

Earlier explicit owner review of P03/P05 reconciles accepted packages to 5/60 (8.3%), 55 remaining; walkthrough still 3/8 (37.5%), not overall MVP percent. Prior timing discussion's provisional remaining Release A estimate is 4–8 weeks at 25–30 collaborative hours/week with external waits separate, low-confidence judgment, next recalibration at ten accepted packages. This repair earns no additional package acceptance.

Google support's owner-supplied reply is technical guidance, not legal certification. Official correction rule: https://developers.google.com/maps/documentation/address-validation/reference/rest/v1/TopLevel/validateAddress ; retention terms: https://cloud.google.com/maps-platform/terms/maps-service-terms . Minimal durable job allowlist remains unchanged.
