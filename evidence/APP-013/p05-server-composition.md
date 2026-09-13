# P05 server composition checkpoint — 2026-09-13

Source backend b10d922/governance 4854069; owner requested proceeding with server wiring. APP013_P05_SOURCE_CARD.md item 2 inspection recorded before coding. Existing package only; no scope deviation.

## Implemented

ControlledIntakeComposition supplies the browser submit port using server-injected intake, credentials, tenant/integration/origin, existing opaque authority/capability, durable phone proof reader, address account/policy and transport. No dependencies means disabled. It validates v2 input and tenant before delegation. No environment loading, provider client construction, listening server or production DI registration.

The existing intake verification factory can now be asynchronous. Exact committed replay precedes factory invocation; only a new admission resolves the actual current reader under transaction to obtain category/scope, then constructs a request-bound AddressOperationLedger and ControlledIntakeVerificationService. Ledger readBinding rechecks session/conversation, current submission digest/category and server policy. Provider I/O remains outside transactions; no receipt-proof cache, positive authority cache or automatic retry.

The existing connected database harness now uses this reusable composition instead of inline verification/ledger wiring. Synthetic SDK/fetch only; actual service and database behavior. Accepted case produces one job and exact receipt replay without additional provider calls; missing phone, outside area, unknown transport and in-flight revocation create none. Existing held-liability and forbidden-field assertions remain. No source assertions were weakened.

## Validation

- Build passed.
- Lint passed after correcting new test-mock typing/async lint errors.
- Full unit suite: 118 suites passed, one skipped; 2,287 tests passed, three skipped. Five new composition tests cover default-disabled, invalid/authority input, foreign tenant, replay-first delegation and failed current reader before providers.
- Architecture passed; production/full dependency audits found zero vulnerabilities.
- Full disposable organization/database/browser harness passed and database cleanup completed. Existing pg concurrent-query deprecation warning remains non-failing. Local log /private/tmp/signmons-p05-composition-db.log; supplemental artifacts /private/tmp/signmons-p05-composition-evidence.
- Commands: npm run build; npm run lint; npm test -- --runInBand; node scripts/architecture-check.mjs; npm audit --omit=dev; npm audit. Database/browser: ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-p05-composition-evidence PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs.
- Governance consistency, frozen baseline, all 21 regression tests and both whitespace checks passed at closeout.

## Review and exact remainder

Review controlled-intake-composition.ts/.spec.ts, continuation factory await and the replacement of inline harness wiring on existing PR21. Verify that replay does not invoke the async factory, and new requests use the real current reader rather than supplied positive proof.

This does not mount the transport in main.ts or alter raw-body/CORS behavior. Item 2 still includes HTTP pre-parser mounting; item 3 is existing customer UI, item 4 is connected desktop/mobile proof. Existing browser regression is not acceptance of that unimplemented journey. P05 remains active, not complete. P06 owns actual resources, caps/window and separately authorized release/live testing.

No merge/deploy, provider setting, credentials, migration, charges, customer data or admin-panel implementation. Accepted packages 3/60 (5%); walkthrough 3/8 (37.5%) unchanged, neither an overall MVP percentage. Low-confidence 60–84 productive-day baseline unchanged; no full package timing sample.
