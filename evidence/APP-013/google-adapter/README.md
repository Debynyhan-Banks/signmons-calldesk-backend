# Disabled Google address adapter

Approved bounded section: src/communications/google-address.adapter.ts and its spec. Default returns DISABLED. Only an injected fixture callback exercises minimal US/OH request mapping. No HTTP client, environment enable switch or production registration. All results preserve false address/admission authority and UNKNOWN county.

19 focused tests cover input refusal, wire mapping, raw-response exclusion, incomplete output, DPV N/D/S, unit/subpremise mismatch and redacted errors with no retry. Full backend: 93 passing suites, 1,772 tests, three existing skips. Build, lint, architecture and diff pass. Initial test-helper lint errors were fixed. No UI change; browser QA not applicable. No dependency/schema change or live action.

Reproduce: npm test -- --runInBand google-address.adapter.spec.ts; npm run lint; npm run build; npm run arch:check; npm test -- --runInBand. Full HTTP tests require loopback permission.

Review both source files and confirm no runtime module imports. This is a fixture adapter foundation, not a complete production validation policy. Semantic matching/component checks, provider deadlines/size limits, county allowlist, session/tenant proof binding, confirmation, reconciliation and live activation remain out of this section. Injected callbacks are trusted test code, not sandboxed code.

Retention defaults are recorded in governance; no cache/deletion implementation is claimed. Submitted-job retention and live budget/account approval remain open. APP-013 stays 50% recorded scope/0 of 12 accepted.

Wire reference checked 2026-09-11: https://developers.google.com/maps/documentation/address-validation/reference/rest/v1/TopLevel/validateAddress
