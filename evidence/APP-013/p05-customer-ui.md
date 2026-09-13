# P05 customer page states — 2026-09-13

Source backend 0fbf3af/governance e878120; owner proceed; pre-code item 3 recorded in APP013_P05_SOURCE_CARD.md. Same existing scripts/fixtures/customer-intake-journey.html/.js, not a new demo/page. No scope deviation.

## Implemented

Opt-in controlled presentation displays customer-entered street/unit/city/ZIP, builds the exact canonical draft address, freezes confirmed address with preview and submits version 2. Page flag is presentation only; absent server resources remain unavailable. Legacy review-only mode unchanged.

Controlled receipts validate request, outcome and false downstream authority. ADMITTED displays job/reference/state without claiming an appointment/payment/dispatch/message. Correction displays a suggestion as text, never automatically adopts it; customer explicitly enters correct fields, reviews and submits a fresh intent. REFUSED retains fields for correction/help; UNCERTAIN, malformed or lost responses retain the exact pending request and disable edits until retry/clear. No automatic retry, localStorage/sessionStorage, proof retention or credential persistence. Reload clears private state and warns to contact the office about existing requests rather than implying recovery.

## Validation

- verify-controlled-intake-ui.mjs tests the same page at 390/1440, six outcomes each: admitted, correction, refusal, uncertain, lost acknowledgment and malformed. Twelve scenarios passed, including explicit correction re-entry, byte-equivalent submission object on retry, no automatic adoption, no horizontal overflow, zero page errors/storage and reload clearing. These use MOCK HTTP results and create no jobs; they are not connected backend acceptance.
- Inspected the mobile admitted screenshot: legible receipt/reference wrapping and no false booking claim. Screenshots/summary: /private/tmp/signmons-p05-ui-evidence.
- Full backend tests: 119 suites passed, one skipped; 2,294 tests passed, three skipped. Build/lint/architecture passed; full/production npm audits zero vulnerabilities.
- Existing complete organization/database/browser regression passed with real services and synthetic providers, disposable cleanup complete. This remains separate from the new controlled-page connection. Log /private/tmp/signmons-p05-ui-db.log; artifacts /private/tmp/signmons-p05-ui-regression. Existing pg concurrent-query warning non-failing.
- Full governance/frozen baseline/all 21 regressions and both whitespace checks passed at closeout. No Next UI files changed; this page was tested directly in Playwright, not represented as a Next UI build.

Commands: npm run build; npm run lint; npm test -- --runInBand; node scripts/architecture-check.mjs; npm audit --omit=dev; npm audit. UI: PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs CONTROLLED_UI_EVIDENCE_DIR=/private/tmp/signmons-p05-ui-evidence node scripts/verify-controlled-intake-ui.mjs. Database regression: ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-p05-ui-regression PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs.

## Review and remaining finish line

Review the existing page/script diff and its browser assertions on PR21. Reproduce screenshots and check exact retry, customer-confirmed address and non-booking language.

ONE existing P05 item remains: item 4 actual controlled desktop/mobile page→HTTP adapter→composition→database journey, with synthetic external provider I/O and refusal/recovery proof. P05 not complete. P06 still owns reviewed managed ingress, real activation/resources, caps/window and separately approved live test. No release, deployment, merge, migration, provider configuration, charges or customer data changed.

Accepted packages 3/60 (5%), walkthrough 3/8 (37.5%) unchanged, neither overall MVP percent. Low-confidence 60–84 productive-day baseline unchanged; no full timing sample or new package.
