# P06/R11 controlled-refusal observability

Decision `4c905715-6259-446b-be7b-1e2e6240125e` alternative 1 is locally implemented from backend `34efe187a4897723a40e114936a1eb8b88579adf` and governance `9316fdc7cb4444ad84d42f6999ae405d865ad340`.

The controlled intake path now attaches one process-local fixed refusal stage to server-created HTTP 409 errors: `INTAKE_STATE_CHANGED`, `LIFE_SAFETY_REFUSAL` or `CURRENT_VERIFICATION_UNAVAILABLE`. A `WeakMap` keeps the stage off the exception's enumerable/serialized surface. The existing browser transport passes only that enum with its existing operation and status diagnostic; the enabled runtime requires the existing `LoggingService` and writes one fixed `CONTROLLED_INTAKE_REFUSAL` marker only for tagged submit 409 responses. Browser status, headers and generic response body remain unchanged. Untagged, non-submit and non-409 diagnostics do not log. Diagnostic/logger failures remain isolated from the application result.

No database field, row, migration, browser field, identifier, request/session/tenant ID, phone, code, address, token, draft, provider output, exception text or stack was added to the diagnostic. No provider behavior, admission rule, retention store or authority changed. Disabled startup still returns before resources are touched. Synthetic/runtime harnesses now inject only a no-op logger.

Validation:

- focused Jest: 5 suites / 275 tests passed;
- full Jest: 130 suites / 2,363 tests passed, with 3 existing skips;
- build, lint and architecture checks passed;
- packet Node tests: 9 passed;
- disposable PostgreSQL 18 packet verifier: 16 checks across 26 migrations, zero live provider/secret calls;
- full restricted-role/disposable PostgreSQL 18 and loopback Playwright harness passed, including eight loaded-browser scenarios at 390/1440 widths, synthetic providers only and zero live provider calls;
- backend/governance consistency, frozen-baseline, governance regression and whitespace checks are recorded at closeout.

Transparent test notes: the first full Jest run was stopped after the sandbox refused local listeners; the permitted rerun exposed one existing order-sensitive Calendar HTTP assertion, which passed alone, and the subsequent full rerun passed. The organization harness first refused the machine's older default PostgreSQL before creating the dedicated PostgreSQL 18 cluster; the dedicated run passed, its fixture database was removed and its owned server was stopped.

This completes local observability only. It does not diagnose the historical enabled21 branch retroactively and does not satisfy R11. No image, packet, live database, LOGIN, activation, deployment, provider request, verification code, customer/browser action, hold release, secret/IAM or billing change occurred. P06 remains 12/14 with R11/full R12 open. Approved observability deviation only; no other scope deviation.
