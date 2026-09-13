# P05 controlled browser adapter checkpoint — 2026-09-13

Source backend f0201ac/governance 2ab7cb1. Owner reviewed P04 and requested continuation after documentation-only admin planning. Existing P05/2B, source card APP013_P05_SOURCE_CARD.md written before coding. No scope deviation.

## Completed item 1 of the existing P05 checklist

CustomerConsentBrowserTransport now recognizes the exact version-2 controlled submit envelope and invokes a separate optional server-injected controlled port. It reuses controlledIntakeSubmission validation and existing origin/context/tenant/session/body/rate controls. Version is a discriminator, not authority. Missing controlled port refuses; it never falls back to legacy submitReview. Legacy requests retain the prior pending-review contract.

controlled-intake-browser-result.ts validates/project results: ADMITTED requires matching request, valid job ID/state and explicit false downstream authority flags; correction allows only bounded US/OH address display fields; refused/uncertain responses create no job claim. Unknown, malformed or over-authorized responses fail closed. Extra private/provider fields are not projected. No persistence, retry, route registration, client credentials, environment defaults or live service wiring was added.

## Validation executed

- Seven new adapter tests; focused suite 93 passed. Cases cover all four outcomes, malformed input/results, wrong request, missing port, no legacy fallback, tenant/origin refusal and private-field projection.
- npm run build: passed.
- npm run lint: passed after correcting a formatter-only test formatting issue.
- npm test -- --runInBand: 117 suites passed, one skipped; 2,282 tests passed, three skipped.
- node scripts/architecture-check.mjs: passed.
- npm audit --omit=dev and npm audit: zero vulnerabilities.
- Existing full disposable organization/database/browser harness passed with synthetic providers and database cleanup; this is regression evidence, not the new controlled UI acceptance. Command: ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-p05-adapter-evidence PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs. Log: /private/tmp/signmons-p05-adapter-db.log. Existing pg concurrent-query warning was non-failing.
- Coordinated closeout passed full governance consistency, frozen baseline, all 21 governance regressions and whitespace checks in both repositories.

## Review and remaining work

Review the transport/spec and new result projector on existing PR21. Confirm v2 cannot enter the legacy port, missing port is disabled, and projected status does not authorize payment, booking, dispatch or delivery.

Items 2–4 remain: disabled-by-default actual server composition; existing customer page correction/exception/restart/created states; connected desktop/mobile proof. No substitute demo or new package. P06 still owns separately authorized live acceptance. No UI completion, deployment, merge, provider request, charge, migration or real customer change occurred.

P04 local package acceptance is recorded from owner review and continuation; P05 remains active. Remaining-plan accepted 3/60 (5%); walkthrough 3/8 (37.5%) unchanged and not overall MVP percentage. Historical P03 R not independently promoted. Low-confidence 60–84 productive-day baseline unchanged; partial patch timing is not a completed package sample.
