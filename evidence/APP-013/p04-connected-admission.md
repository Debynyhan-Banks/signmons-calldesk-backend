# P04 final connected admission proof — 2026-09-13

P04 is locally review-ready (R), not owner-accepted or live-enabled. This completes the last existing item in APP013_P04_SOURCE_CARD.md; no new section, package or scope deviation. Source: backend 5eec327, governance 6cf97f7. Existing feature branches preserved.

## Actual connection exercised

The disposable organization/operator harness now joins actual DurableVerificationService, TwilioVerifyAdapter, database VerificationBudgetAdmission, AddressOperationLedger, GoogleAddressOAuthTransport, ControlledIntakeVerificationService, current submission reader and atomic controlled writer. Only external SDK/fetch are synthetic. Pricing is explicitly FIXTURE_ONLY, not a verified provider rate. No positive verification callback is substituted in these five connected cases.

- Missing phone proof refuses before address dispatch, with no job.
- Valid phone/address creates exactly one job; exact committed replay returns the same receipt without either provider adapter being invoked again.
- Outside-area and unknown-transport results create no job.
- Authority revoked during address I/O refuses admission, with no job.
- Stored job/audit exclude provider sentinel, county/proof/verdict fields. Four address operations each retain 10 fixture micros; four phone reservations each hold 10 fixture micros. Synthetic calls: eight phone, four address; live calls: zero.

After asserting phone reservations, the harness removes only their exact audit IDs in the guarded disposable database so the subsequent independent budget-boundary regression starts empty. This is test teardown, not runtime reconciliation or liability release. The entire disposable database is dropped at exit. No real data was changed.

## Validation

- Build and lint passed.
- Unit tests: 117 suites passed, one skipped; 2,275 passed, three skipped.
- Architecture check passed; production and full npm audits: zero vulnerabilities.
- Complete organization database/browser harness passed, including existing desktop/mobile customer/operator, rollback, replay, role/tenant, payment-policy and budget regressions; disposable database cleanup completed.
- Initial runs exposed a BigInt serialization assertion and shared fixture-budget contamination. Both test-harness issues were corrected; the final full run exited zero. No application guard was weakened.
- Full governance consistency, frozen-baseline, all 21 governance regression tests and both repository whitespace checks passed at coordinated closeout.

Reproduce from the built focused backend:

```sh
npm run build
npm run lint
npm test -- --runInBand
node scripts/architecture-check.mjs
npm audit --omit=dev
npm audit
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-p04-connected-evidence.bZDaYV PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
```

Local evidence: /private/tmp/signmons-p04-connected-evidence.bZDaYV; final run log: /private/tmp/signmons-p04-connected-db.log. These temporary artifacts are supplementary; committed assertions are reproducible evidence. Existing pg concurrent-query deprecation warning remains non-failing.

## Review and remaining boundary

Review this harness diff on existing PR21, then p04-current-submission.md, p04-atomic-writer.md, p04-receipt-replay.md and p04-operator-recovery.md. Confirm the connected success/refusal cases and that provider substitutions occur only at the external boundary. P04 has no newly proposed implementation item; owner review is next. P05 composition and P06 controlled live acceptance remain separately gated and unchanged. No route activation, real verification, deployment, merge, sending, charge, production migration or provider configuration occurred.

Accepted walkthrough remains 3/8 (37.5%); accepted remaining-plan packages remain 2/60. R is not D. The original 60–84 productive-day low-confidence estimate is unchanged; focused work and owner wait were not fully separated, so no new velocity sample is claimed.
