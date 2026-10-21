# APP-013 / 3A / P07 read-only diagnostic package preparation

Date: October 21, 2026, Eastern time

## Requirement traceability

- Approved section: R1-W01 / APP-013/3A/P07.
- Exact customer criterion: the same admitted job opens one authorized Stripe Sandbox Checkout from its approved payment policy, and only an authentic signed event for the exact stored Stripe resource may clear the payment gate.
- Approved change: Debynyhan Banks approved Alternative 1 in `APP013_P07_READ_ONLY_DIAGNOSTIC_WINDOW_REDUCTION_PROPOSAL_20261021.md` for local diagnostic-only package preparation and testing.
- Demonstrated process gap: the prior 90-minute window covered a mutation-capable readiness operation, while the immediate predicate diagnostic requires only fresh read-only Stripe qualification, exact read-only database inspection, rollback and connection closeout.
- Customer-workflow connection: the diagnostic identifies the exact prerequisite blocking the accepted job's payment-runtime readiness without weakening or exercising any payment, booking or customer-action authority.

## Prepared package

Fresh private package: `/private/tmp/p07-read-only-diagnostic-20261021-prep1`.

- plan `55d7dc3a-4fe3-4f09-8ada-bcbd7ef3ad02`;
- packet `3acd1d03-07bf-4007-a399-03ff2d30a9b4`;
- operation `c15a9092-f421-4c5b-94bd-4e7b158c6595`;
- manifest SHA-256 `1e5aced9a7aded528bbb60e0402cb65b67bf30bb4cdb5f71706832535788510b`;
- status `PREPARATION_ONLY_PENDING_WINDOW_AND_LIVE_APPROVAL`;
- no binding, owner approval, attempt, Stripe receipt, diagnostic result, stop or closeout receipt exists.

The controller enforces the exact relative envelope: start cutoff at minute 10, diagnostic deadline at minute 20, closeout deadline at minute 25 and window end at minute 30. Both database paths require `PGSSLMODE=verify-full`, `PGSSLROOTCERT=system`, bounded timeouts and operation-scoped application names.

The diagnostic SQL contains only the reviewed exact predicates inside `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` and `ROLLBACK`. The closeout SQL is separately read-only and verifies zero remaining operation-scoped sessions. Recovery can perform closeout only and cannot rerun the diagnostic.

Source inspection and tests prove the package contains no callable database mutation, role/grant, secret, IAM, Stripe configuration, deployment, Checkout, payment, refund, booking, message or customer-action path. Raw account identifiers, database output and errors are discarded; receipts contain only fixed codes and booleans.

## Local verification

- Python syntax: passed.
- Focused controller suite: **22/22 passed**.
- Exact 30-minute timing and strict cutoff: passed.
- Exact approval/no-retry validation: passed.
- Positive and every fixed predicate classification, malformed output and multi-failure ordering: passed.
- Hidden input, TLS pins, deadline checks, timeout/interrupt handling and private-value non-disclosure: passed.
- Read-only SQL/mutation-token rejection, mandatory rollback, zero-session closeout and closeout-only recovery: passed.
- `controller.py --check`: `P07_DIAGNOSTIC_PREPARATION_CHECK_PASSED_NO_ACTION`.
- `controller.py --run`: refused `P07_DIAGNOSTIC_REFUSED_WINDOW_NOT_BOUND` before hidden input or external access.
- `controller.py --recover`: refused `P07_DIAGNOSTIC_REFUSED_WINDOW_NOT_BOUND` before hidden input or external access.

## Boundaries and next gate

No application source, database, role, grant, secret, IAM, Stripe configuration, Cloud resource, deployment, payment, booking, message or customer data changed. Repair 5 and all consumed operations remain unchanged. No push occurred.

The next step is owner selection of a fresh attended 30-minute Eastern window with Terminal, the current CHILD administrator password and signed-in Stripe Sandbox available. The implementer then binds and retests this exact package and presents a separate exact external diagnostic proposal. Local preparation approval does not authorize that browser/database access.

Accepted progress remains **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. **No scope deviation from the approved P07-specific narrowing.**
