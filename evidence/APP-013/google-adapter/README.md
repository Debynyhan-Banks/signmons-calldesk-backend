# Disabled Google address adapter

## Response-policy hardening (current)

39 focused tests (20 additional) and full backend 93 passing suites/1,792 tests, three existing skips. Build, lint, architecture and diff checks pass. Required typed postal fields and bounded unique confirmed components now complement the complete verdict and DPV gate. Missing/unconfirmed/unresolved component lists must be absent or empty arrays; malformed booleans refuse. Supplied units require confirmed subpremise plus matching granularity. Ordering does not matter; corrections can only yield nonauthoritative REVIEW. No source response is returned or persisted. No browser surface or runtime registration changed.

Review the two source-file diffs against 6533d65 and rerun the commands below. This does not yet compare normalized input and output semantics or qualify county records. Provider deadlines/reconciliation/session binding and real acceptance remain gated. Fixture authority remains false on every path.

Reference: Google's validateAddress REST reference, checked 2026-09-11, defines component confirmation and granularity independently of geocode precision. This implementation is intentionally conservative and is not a deliverability guarantee.

## Prior foundation evidence

Current section additional gates: production and full dependency audits each found zero vulnerabilities after a permitted network retry (initial sandbox DNS lookup failed). Governance consistency and all four execution-placement tests passed. No UI/dependency/schema changes.

Approved bounded section: src/communications/google-address.adapter.ts and its spec. Default returns DISABLED. Only an injected fixture callback exercises minimal US/OH request mapping. No HTTP client, environment enable switch or production registration. All results preserve false address/admission authority and UNKNOWN county.

19 focused tests cover input refusal, wire mapping, raw-response exclusion, incomplete output, DPV N/D/S, unit/subpremise mismatch and redacted errors with no retry. Full backend: 93 passing suites, 1,772 tests, three existing skips. Build, lint, architecture and diff pass. Initial test-helper lint errors were fixed. No UI change; browser QA not applicable. No dependency/schema change or live action.

Reproduce: npm test -- --runInBand google-address.adapter.spec.ts; npm run lint; npm run build; npm run arch:check; npm test -- --runInBand. Full HTTP tests require loopback permission.

Review both source files and confirm no runtime module imports. This is a fixture adapter foundation, not a complete production validation policy. Semantic matching/component checks, provider deadlines/size limits, county allowlist, session/tenant proof binding, confirmation, reconciliation and live activation remain out of this section. Injected callbacks are trusted test code, not sandboxed code.

Retention defaults are recorded in governance; no cache/deletion implementation is claimed. Submitted-job retention and live budget/account approval remain open. APP-013 stays 50% recorded scope/0 of 12 accepted.

Wire reference checked 2026-09-11: https://developers.google.com/maps/documentation/address-validation/reference/rest/v1/TopLevel/validateAddress
