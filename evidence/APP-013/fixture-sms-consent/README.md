# Fixture-only SMS consent capture — 2026-09-12

Review-ready local proof, not production consent or live enrollment.

The existing intake supports an explicitly enabled fictional-policy prompt, an initially unchecked choice, capture, exact capture-response replay and continuation without texts. The inactive transport requires its fixture binding and injected model. Tenant/session credentials, current phone and revision, policy version, disclosure and sender must still match at capture. Existing opt-out refuses enrollment; skipping does not erase it. Missing policy refuses capture.

All receipts report fixtureOnly=true, liveConsentRecorded=false and deliveryAuthorized=false. Records exist only in process memory (256 prompts maximum, five-minute/session deadline); restart discards them and refuses old prompts. There is no database schema, production registration, provider call or export to a live sending authority.

## Validation

- Backend build, lint, architecture and diff whitespace checks passed.
- Jest: 100 suites and 1,906 tests passed; one suite/three tests skipped.
- Production dependency audit: zero vulnerabilities.
- Browser: 390px and 1280px prompt/capture, unchecked initial state, lost-response exact replay, skip without write and draft preview without texts passed. Screenshots visually reviewed.
- Existing unavailable-policy branch regression passed at both widths.

Browser capture uses the real fixture model and protected transport, with mocked intake responses and local fictional policy pages. It is not a durable database, provider or production-browser demonstration. See summary.json and fixture-sms-390.png / fixture-sms-1280.png.

## Reproduce and review

Run npm run build, npm run lint, npm run arch:check and npm test -- --runInBand. Set PLAYWRIGHT_MODULE to an installed Playwright index.mjs and SMS_INTAKE_EVIDENCE_DIR to an explicit output directory; run node scripts/verify-fixture-sms-consent.mjs. With the same environment, run node scripts/verify-sms-intake-unavailable.mjs for the default disabled branch.

Review the screenshots, receipt flags in summary.json, stale/foreign/opt-out/restart cases in fixture-sms-consent.spec.ts and the fixture-binding transport tests. The UI flag alone cannot activate the server port.

## Remaining boundary

Durable, transactional consent evidence and a production trusted policy/lifecycle source are not implemented by this fixture. Approved public policy URLs, effective version and release/provider approvals remain prerequisites to live enrollment. No merge, deployment, Twilio/DNS setup, real recipient, payment or sending action occurred.

APP-013 remains Now. Fixed steel-thread acceptance stays 3/8 (37.5% milestones, not overall engineering completion); this is not a ninth milestone. Next proposed bounded section is durable consent evidence with current-policy/recipient checks and sending still disabled, subject to owner review and approval.
