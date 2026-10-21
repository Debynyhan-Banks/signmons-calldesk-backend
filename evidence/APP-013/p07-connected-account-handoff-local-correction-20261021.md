# APP-013 / 3A / P07 connected-account handoff local correction

Date: October 21, 2026, Eastern time

## Requirement traceability

- Approved section: R1-W01 / APP-013/3A/P07.
- Acceptance criterion advanced: the admitted job must later complete one authentic Sandbox payment whose correlated event clears its payment gate before booking. This correction only restores the bounded runtime-readiness path needed for that proof; it does not satisfy the criterion.
- Demonstrated missing behavior: consumed repair-2 operation `45ae622a-2cb7-4ab7-ae90-f94d30c9336a` stopped before database access or mutation with `P07_STOP_CONNECTED_ACCOUNT_FORMAT` because a browser-scoped clipboard did not transfer the private connected-account ID to Terminal.
- Approved source: governance commit `67c504b18430cb8f9bcab0f40636f31120425a52`, `APP013_P07_CONNECTED_ACCOUNT_HANDOFF_CORRECTION_PROPOSAL_20261020.md`, Alternative 1 approved for local correction and testing only.
- Connected workflow: this preflight proves the tenant's stored Stripe destination identity and charges-enabled state match the sanitized provider observation before the payment runtime can be prepared. It preserves the `enforce payment/policy -> book` boundary.

## Implemented local correction

Fresh private package: `/private/tmp/p07-repaired-runtime-readiness-20261021-repair3`

- Plan: `469fc707-51d9-406a-b8df-c55b078f4eba`
- Packet: `95e56ac2-afea-4efc-b7bc-78fb2507d576`
- Operation: `0ae8a2a9-530f-47c6-80da-3bcd740a821d`
- Manifest SHA-256: `a95a014cd7b81ff66dc006c30c51d1d4dfb4b6ab27f619a4d4e61587de1db180`
- Controller SHA-256: `3d242c8980280f586331e01ca515994f202e6114a4e726f3834fe1f5dff9e41f`
- Test SHA-256: `55590ea3794c2aba353da2f9ddf76ce03892a2c390abe87afb9a533bd495c990`

The database preflight now uses only the fixed plan-bound job and tenant UUIDs in SQL. It reads the tenant's stored connected-account ID and `chargesEnabled` result as one in-memory result line, requires exactly one tenant row, validates the `acct_...` format, compares its SHA-256 with the already sanitized Stripe preflight receipt using constant-time comparison, then clears the raw value and result lines. The raw ID is absent from prompts, SQL, command arguments, exceptions and persisted receipts. The persisted database receipt retains only `tenantAccountMatchesAndChargesEnabled:true`.

The fresh package contains no binding, owner-approval, attempt or mutation-journal file. Its plan remains `PREPARATION_ONLY_PENDING_WINDOW_AND_LIVE_APPROVAL`, `externalActionAuthorized:false`, and `automaticRetryAllowed:false`. Both previous operations remain consumed.

## Validation

- `python3 -m unittest -v test_controller.py`: **33/33 passed**.
- Positive preflight test proves exact fixed job/tenant SQL, successful in-memory hash match, no raw account ID in SQL and no raw account ID in the persisted receipt.
- Negative tests prove named refusal for missing/extra tenant output, malformed ID, disabled charges and provider/database hash mismatch; no success receipt is written.
- Source test proves the connected-account prompt and external account argument are absent.
- `python3 -m py_compile controller.py test_controller.py`: passed.
- `node --check db-closeout.mjs firebase-read.mjs iam-actas-read.mjs`: passed.
- `python3 controller.py --check`: `P07_PREPARATION_CHECK_PASSED_NO_ACTION`.
- `--run`, `--recover` and `--retire`: each refused `P07_REFUSED_WINDOW_NOT_BOUND` with exit 2.
- Private package directory mode: `0700`.

No Cloud, Stripe or database command ran during this local correction. No role, secret, IAM binding, destination, revision, payment, booking, customer contact or deployment was attempted.

## Remaining gate

Debynyhan Banks supplies a fresh attended Eastern block of at least 90 minutes with Terminal, the current CHILD administrator password and signed-in Stripe Sandbox available. The implementer may then create an exact window/retirement binding, rerun all package checks and present a separate external-operation proposal. No executable live command or external authority exists at this checkpoint.

Accepted progress remains **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. **No scope deviation from the owner-approved connected-account handoff correction.**
