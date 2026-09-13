# P05 final connected browser proof — 2026-09-13

Source backend 8e53f51/governance d2be4a8. Owner requested continuation; final item 4 pre-code scope recorded in APP013_P05_SOURCE_CARD.md. P05 locally review-ready (R), not owner-accepted, deployed or live-enabled. No new package or scope deviation.

## Connection and fixture boundaries

The existing organization/operator disposable database harness invokes verify-controlled-intake-connected-browser.mjs. It renders the same customer-intake-journey.html/.js and mounts actual customerSessionHttp, CustomerConsentBrowserTransport and ControlledIntakeComposition. Conversation, draft preview, current policy reader, address operation accounting and atomic job writer are actual services against disposable PostgreSQL. No mocked positive draft or admission response.

Fixture setup explicitly provisions a genuine new session via the actual response service and prepares durable phone START/CHECK via actual verification/budget services with synthetic SDK replies. The browser Start returns that fixture-owned session; this is not production identity onboarding or an end-to-end live phone-code UX claim. External Google fetch is synthetic. Local loopback mode is explicit and does not qualify Cloud Run ingress; production main remains without activation resources. Actual operator recovery and session expiry remain covered by the existing database regressions, not bypassed by browser credentials.

## Eight connected scenarios

At each of 390 and 1440 pixels:

1. Accepted address creates one job. After commit, the test replaces the acknowledgment with HTTP 503; the page retains its exact request and explicit retry reads the same receipt with no new provider request/job.
2. Outside-area response creates no job and retains customer fields.
3. Unknown address transport creates no job and retains the exact pending request with editing disabled.
4. Address correction is displayed, not auto-adopted. Customer explicitly re-enters 174 Fictional Lane, reviews and submits a fresh request; the second permitted address check creates one job.

All cases check no page errors, no horizontal overflow, no browser storage, reload clearing and truthful receipt language. Mobile corrected/admitted screenshot inspected. Four jobs originate from the browser cases. Whole operator harness: 11 fictional jobs (prior regression cases included), 24 synthetic phone calls, 14 synthetic address calls, zero live calls. Exact counters verify no extra address dispatch during replay. Correction cases retain both operation holds; other non-missing-phone cases retain one; existing phone-liability/privacy assertions preserved. Guarded synthetic reservation teardown and full disposable database drop remain intact.

Initial closed-socket acknowledgment injection triggered Chromium's transparent retry and the expected retry-button assertion failed: actual results were two ADMITTED receipts. The fault was changed to deterministic post-commit HTTP 503 to test visible user retry, then the complete suite passed. This changes test fault delivery, not application semantics or guards.

## Validation

- Full connected organization/database/browser harness passed; disposable cleanup completed. Existing pg concurrent-query deprecation warning non-failing.
- Full backend: 119 suites passed, one skipped; 2,294 tests passed, three skipped. Build/lint/architecture passed; production/full dependency audits zero vulnerabilities.
- Twelve independent mocked-outcome UI regressions also passed; these supplement rather than replace connected proof.
- Full governance consistency/frozen baseline, all 21 governance regression tests and both whitespace checks passed at closeout.

Reproduce: npm run build; npm run lint; npm test -- --runInBand; node scripts/architecture-check.mjs; npm audit --omit=dev; npm audit.

Connected run: ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-p05-connected-evidence PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs. Log /private/tmp/signmons-p05-connected-db.log; screenshots connected-{accepted,outside,unknown,correction}-{390,1440}.png and operator-admission-summary.json in that evidence directory. Temporary artifacts supplement committed reproducible assertions.

## Review and next boundary

Review the new connected browser helper and its integration into the existing operator harness on PR21, then screenshots and counters. Check the four P05 card items against p05-browser-adapter.md, p05-server-composition.md, p05-http-mount.md and p05-customer-ui.md. All local items now addressed; owner review is next. No additional P05 implementation section proposed.

P06 is unchanged: separately reviewed actual deployment/ingress mapping, resource/identity/config binding, limits/window, paid-run authority and real verification/job acceptance. Missing live configuration remains a release gate, not a fabricated default. No merge/deploy, migration, secrets/IAM, provider settings, charges, real customer data or admin-panel work occurred.

Accepted packages stay 3/60 (5%); walkthrough stays 3/8 (37.5%). R is not D and neither fraction is overall MVP completion. Low-confidence 60–84 productive-day baseline unchanged; elapsed work and review waits were not separated enough for a new completed-package timing sample.
