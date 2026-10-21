# APP-013 / 3A / P07 database-preflight predicate local correction

Date: October 21, 2026, Eastern time

## Requirement traceability

- Approved section: R1-W01 / APP-013/3A/P07.
- Exact acceptance criterion: the same admitted job opens one authorized Stripe Sandbox Checkout from its approved payment policy, and only an authentic signed event for that exact stored Stripe resource may clear the payment gate.
- Approved change: owner approved Alternative 1 in `APP013_P07_DATABASE_PREFLIGHT_PREDICATE_DIAGNOSTIC_PROPOSAL_20261021.md` for local correction and testing only.
- Demonstrated missing behavior: consumed repair 4 reached database-state evaluation and returned only `P07_STOP_DATABASE_PREFLIGHT_DRIFT`; source inspection showed that database identity, role, job, payment, calendar, policy and tenant-account predicates shared that single code.
- Customer-workflow connection: the correction makes the prerequisite for the existing job's payment path observable without weakening any gate, so a future separately approved read-only diagnostic can identify the exact blocker before payment-runtime provisioning.

## Local result

Fresh disabled package `/private/tmp/p07-repaired-runtime-readiness-20261021-repair5` uses:

- plan `2058551c-6a4f-468b-8a26-f860b754e8db`;
- packet `e40c598f-f918-425b-8368-c6062cec0d5d`;
- operation `1b1a983c-40c5-4100-98f5-9d4dd3102803`;
- manifest SHA-256 `17c5fad2837ec01bb590d1607f4dbdaf88ab48ee3f8856fadf27f61279ced6fe`.

The classifier now emits only these fixed allowlisted codes, in deterministic first-failure order:

- `DATABASE_PREFLIGHT_OUTPUT_INVALID`
- `DATABASE_IDENTITY_DRIFT`
- `P07_ROLE_COLLISION`
- `P06_ROLE_STATE_DRIFT`
- `EXACT_JOB_COUNT_DRIFT`
- `JOB_STATE_DRIFT`
- `JOB_DELETED`
- `PAYMENT_ACTIVITY_PRESENT`
- `CALENDAR_EVENT_PRESENT`
- `CALENDAR_OPERATION_PRESENT`
- `CONTROLLED_ADMISSION_POLICY_DRIFT`
- `CONNECTED_ACCOUNT_FORMAT`
- `CONNECTED_ACCOUNT_CHARGES_DISABLED`
- `STRIPE_PREFLIGHT_DRIFT`
- `CONNECTED_ACCOUNT_MISMATCH`

Raw query output and the connected-account identifier remain in process memory only and are cleared or discarded. No password, host, database URL, query row, account identifier or raw exception is persisted or emitted. Both PostgreSQL paths retain `PGSSLMODE=verify-full` and `PGSSLROOTCERT=system`.

## Verification

- Python syntax: passed.
- Focused controller suite: **36/36 passed**.
- Positive path, every fixed negative code, malformed output, numeric parsing, multi-failure ordering and private-value non-disclosure: passed.
- `controller.py --check`: `P07_PREPARATION_CHECK_PASSED_NO_ACTION`.
- `--run`, `--recover` and `--retire`: each refused `P07_REFUSED_WINDOW_NOT_BOUND` before hidden input or external access.
- Fresh package has no `binding.json`, `owner-approval.json`, `attempt.json` or `mutation-journal.json`.

## Boundaries and next gate

This correction changed only the fresh private package plus evidence/governance records. It made no application-source, database, role, grant, secret, IAM, Stripe, Cloud, deployment, payment, booking, message or customer-data change. Repair 4 and all earlier operations remain consumed.

The next observable result requires a separate owner-approved, fresh attended window for one read-only diagnostic. This package has no live authority and must not be run against providers until separately bound, retested and approved.

Accepted progress remains **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. **No scope deviation from the approved local correction.**
