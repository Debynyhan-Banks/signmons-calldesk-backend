# APP-013 / 3A / P07 diagnostic total-output local correction

Date: October 21, 2026, Eastern time

## Scope and traceability

- Approved section: R1-W01 / APP-013/3A/P07.
- Unchanged acceptance criterion: the same admitted job opens one authorized Stripe Sandbox Checkout from its approved payment policy, and only an authentic signed event for that exact stored Stripe resource may clear the payment gate.
- Demonstrated gap: consumed diagnostic operation `c15a9092-f421-4c5b-94bd-4e7b158c6595` returned `P07_DIAGNOSTIC_STOP_DATABASE_PREFLIGHT_OUTPUT_INVALID` because the composite SQL/parser contract was not total over absent-row and null-producing states.
- Approved source: governance `APP013_P07_DIAGNOSTIC_TOTAL_OUTPUT_CORRECTION_PROPOSAL_20261021.md`, Alternative 1; Debynyhan Banks approved local correction and testing only.
- Customer-workflow connection: this makes the exact-job/role/tenant prerequisite trustworthy before a later separately approved P07 payment-readiness operation. It creates no customer capability or acceptance credit.

## Fresh disabled package

Package: `/private/tmp/p07-read-only-diagnostic-total-output-20261021-prep1`.

- plan `e594290a-a142-42bb-8b26-d60908e9eed9`;
- packet `29e40c3f-bdee-49cc-bf06-ff9d6bdc5fe9`;
- operation `8f71217a-d384-4a0c-87da-3d3703a4201f`;
- manifest SHA-256 `b9d3deac90eedea69faf5f5735068ec65240739b9b1c377db7d3f9a648f3e7ae`;
- controller SHA-256 `a9c05d2bbaafa10a6a8603bc10b63b6394b472dc7cdf2a67fd1db3b8f8f61b73`.

The package has no window, binding, owner live-operation approval, attempt or result receipt. Every package file is mode 0600 and the directory is mode 0700.

## Corrected contract

- The read-only query always emits exactly three ordered tags: `IDENTITY`, `JOB` and `TENANT`.
- Explicit 0/1 encodings, counts, aggregates and `COALESCE` prevent absent P06-role, job or tenant rows and null fields from removing or ambiguously shortening output.
- The tenant account is base64-framed only for delimiter-safe in-process transport, decoded in memory, validated/hashed and cleared. It is never emitted or persisted.
- P06 absence is classified as `P06_ROLE_STATE_DRIFT`; job absence as `EXACT_JOB_COUNT_DRIFT`; tenant absence as `TENANT_COUNT_DRIFT`; null/invalid account as `CONNECTED_ACCOUNT_FORMAT`.
- Database identity, P07 collision, job state/deletion, payment/calendar activity, admission-policy, connected-account fingerprint and charges-enabled checks remain fail closed and ordered.
- Preparation and consumed-receipt validation are separate. Immutable attempt/result/closeout receipts will no longer make a post-operation verification suite fail merely because they exist, while pre-reservation absence remains required.
- The controller retains repeatable-read read-only SQL, rollback, `verify-full`, system roots, hidden input, deadlines, exclusive reservation, no retry, closeout-only recovery and zero-session verification. It contains no callable mutation or provider-resource path.

## Verification

- Focused controller suite: 23/23 passed.
- Disposable PostgreSQL 16.11 contract suite: 5/5 passed against a temporary Unix-socket-only cluster with synthetic data. It executed the real diagnostic SQL for success, absent P06 role, absent job, absent tenant and null account; each result remained exactly three tagged rows and reached the intended fixed classification. The successful path rolled back, left zero other operation-named sessions and the temporary cluster was removed.
- Combined result: 28/28 passed.
- Python syntax passed.
- `python3 controller.py --check`: `P07_DIAGNOSTIC_PREPARATION_CHECK_PASSED_NO_ACTION`.
- `--run` and `--recover`: each refused `P07_DIAGNOSTIC_REFUSED_WINDOW_NOT_BOUND` before hidden input or external access.

The consumed predecessor and receipts remain hash-identical: attempt `2480927296f714c721dd0ef083f07b23dc749b30a530273fb9b22e3e935a153c`, Stripe preflight `46e8ab699ae70e31231822f55d41b604becc8450b50ffdf2916d5bed3c248f19`, stop `e4856174933e96859a7dba7a69dfc9686f82eb678a4b88a5523ef4477de91329` and closeout `8e2a7b84b5883e9dc393437b3d5d6e536173afd90b5311cd13f83f1296f71eee`.

## Boundaries and next step

No application source, live database, Stripe, role/grant, secret/IAM, deployment, Checkout, payment, booking, message, customer, merge or push action occurred. The disposable local database used only synthetic data and was removed.

The local correction is complete. A future read-only diagnostic still requires a fresh attended 30-minute window, exact binding/retest and separate owner approval. P08, payment execution and 3A acceptance remain later gates.

Accepted progress remains **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. **No scope deviation from the approved local correction.**
