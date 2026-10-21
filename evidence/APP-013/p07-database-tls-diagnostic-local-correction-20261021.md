# APP-013 / 3A / P07 database TLS diagnostic local correction

Date: October 21, 2026, Eastern time

## Requirement traceability

- Approved section: R1-W01 / APP-013/3A/P07.
- Acceptance criterion advanced: a future authentic Sandbox payment must clear the admitted job's payment gate before booking. This correction only repairs the database-readiness controller needed before that proof; it does not satisfy the criterion.
- Demonstrated gap: consumed repair-3 operation `0ae8a2a9-530f-47c6-80da-3bcd740a821d` stopped at database preflight with a generic `P07_STOP_COMMAND_FAILED`; local evidence showed `psql` used `verify-full` without a root file or explicit system-root selection.
- Approved source: governance commit `e1342bbc37f570f97b6f25b98aef7f8f0222e0f4`, `APP013_P07_DATABASE_TLS_DIAGNOSTIC_CORRECTION_PROPOSAL_20261021.md`, Alternative 1 approved for local correction and testing only.
- Connected workflow: readiness must prove the tenant/job/payment-policy state through a certificate- and hostname-verified database connection before payment infrastructure can be prepared.

## Implemented local correction

Fresh private package: `/private/tmp/p07-repaired-runtime-readiness-20261021-repair4`

- Plan: `0f2daeb9-fc75-40c2-b66b-097b6c986d7d`
- Packet: `67157149-adc5-4a5b-a5c3-93066071403e`
- Operation: `609bca17-276b-493f-bbd8-6edf7d5ad7e9`
- Manifest SHA-256: `bfcbc38b89efe5c63d1f6a9bf4a06250376780f52cd634254d904767c5af3727`
- Controller SHA-256: `b4b6c1d56333ed968eb6b122f4f613727453d5928cdc5f84b503333b8268743d`
- Test SHA-256: `b014794c34b079c8766b017e5afa1c658c5b420f3a96af09b27b97dbb587644e`

Both administrator and generated restricted-role `psql` environments now set `PGSSLMODE=verify-full` and `PGSSLROOTCERT=system`. No TLS fallback exists. Failed `psql` stderr is inspected only in process memory, mapped to one fixed stop code and discarded; passwords, host details, role names and raw error text are never emitted or persisted.

Fixed classifications are `DATABASE_TLS_CONFIGURATION`, `DATABASE_CONNECTION`, `DATABASE_AUTHENTICATION`, `DATABASE_SCHEMA_OR_QUERY`, and fail-closed `COMMAND_FAILED` for unclassified errors. Exact job/tenant/account-hash checks and existing receipts remain unchanged.

The package contains no binding, approval, attempt, provider receipt or mutation journal. Its plan remains `PREPARATION_ONLY_PENDING_WINDOW_AND_LIVE_APPROVAL`, `externalActionAuthorized:false`, and `automaticRetryAllowed:false`. All earlier operations remain consumed.

## Validation

- `python3 -m unittest -v test_controller.py`: **35/35 passed**.
- Both administrator and restricted-role tests require `verify-full` plus `PGSSLROOTCERT=system` and prove no `require` fallback.
- Five error-classification cases prove fixed codes and no raw private detail in exceptions.
- Existing positive/negative account, exact-job, role, environment, interruption and containment tests remain green.
- Python and Node syntax checks passed.
- `python3 controller.py --check`: `P07_PREPARATION_CHECK_PASSED_NO_ACTION`.
- `--run`, `--recover` and `--retire`: each refused `P07_REFUSED_WINDOW_NOT_BOUND` with exit 2.
- Private package directory mode: `0700`.

No database connection, Cloud, Stripe, IAM, secret, deployment, payment, booking or customer action occurred.

## Remaining gate

Debynyhan Banks supplies a fresh attended Eastern block of at least 90 minutes with Terminal, the current CHILD administrator password and signed-in Stripe Sandbox available. The implementer may then bind/retest and present a separate exact external-operation proposal. No executable live command or external authority exists at this checkpoint.

Accepted progress remains **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. **No scope deviation from the approved TLS/diagnostic correction.**
