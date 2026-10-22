# APP-013 / 3A / P07 tenant Stripe binding local preparation

Date: October 22, 2026, Eastern time

## Scope and traceability

- Approved section: R1-W01 / APP-013/3A/P07.
- Unchanged acceptance criterion: the same accepted job opens one authorized Stripe Sandbox Checkout from its approved payment policy, and only an authentic signed event for its exact stored Stripe resource may clear the payment gate.
- Demonstrated prerequisite: consumed diagnostic operation `8f71217a-d384-4a0c-87da-3d3703a4201f` proved the exact tenant's stored connected-account value is absent or malformed.
- Owner authority: Debynyhan Banks approved Alternative 1 in governance `APP013_P07_TENANT_STRIPE_BINDING_CORRECTION_PROPOSAL_20261022.md` for local preparation/testing only.
- Customer-workflow connection: the exact tenant must be bound to the enabled Sandbox destination before policy enforcement can create a Checkout or webhook truth can settle the job.

## Fresh disabled package

Package: `/private/tmp/p07-tenant-stripe-binding-correction-20261022-prep1`.

- plan `8ba2a1c8-d845-4111-b1f7-27e636b0fd1a`;
- packet `13471d52-2195-4620-b6a4-b6282e4a70c6`;
- operation `aff460dd-740b-40c4-8fcc-ea6dbc21057e`;
- audit ID `b80bbf11-198a-4829-9e41-2106a0b1e713`;
- controller SHA-256 `d8f1d27fba8393cf5a86c8e6ea2f2f574a48f12c22e89097cbbff3d54dd2f52e`;
- manifest SHA-256 `7eb4cbf4ace386273000df8e41a1784b02960cbc18eaa1c38b5a5436e74472dd`.

The package contains exactly six mode-0600 files in a mode-0700 directory. It has no window, binding, external-operation proposal, owner live approval, Stripe receipt, attempt, mutation intent or result. `--run` and `--recover` both refuse `P07_TENANT_BINDING_REFUSED_WINDOW_NOT_BOUND` before hidden input or database access.

## Prepared behavior

- Fresh Stripe evidence must show Sandbox/Test mode, administrator access, exactly one enabled connected account and destination absence. Only its SHA-256 may persist.
- The raw account is entered twice through hidden input, must match exactly, satisfy the fixed `acct_...` format and hash-match the sanitized browser receipt. It is never stored in a file, command argument, log, exception, receipt or audit.
- A serializable read-only preflight names tenant, job, payment, calendar, policy and prior-operation drift with fixed codes and returns no raw account value.
- The only write transaction conditionally updates the exact active tenant's `stripeConnectAccountId`, `chargesEnabled` and `updatedAt` while the accepted job remains undeleted `CREATED`, has no Payment or calendar activity and retains the controlled-admission digest. It refuses an already-valid account, any prerequisite drift or a competing update.
- The same transaction inserts exactly one fixed `AuditLog` row containing only operation identity, the account SHA-256 and fixed before/after classifications. Audit failure rolls back the tenant update.
- A separate read-only readback requires exact account equality, `chargesEnabled=true` and the exact audit. Mutation intent is durable before the write; a lost response is consumed and recovery can perform only this readback and session closeout, never repeat the update.
- All paths retain `automaticRetryAllowed:false`, fixed deadlines, private receipts and operation-scoped zero-session closeout.

## Local verification

- Focused controller tests: 14/14 passed. They cover double hidden confirmation, format/hash/provider-mode checks, every fixed preflight failure and first-failure order, exact SQL/table scope, read-only guards, update/audit result cardinality, private exclusive receipts, exact approval, positive execution sanitization, successful uncertain-commit recovery and failed recovery with truthful unconfirmed commit state.
- Disposable PostgreSQL 16.11 tests: 5/5 passed against a temporary Unix-socket-only cluster with synthetic data. They prove one exact commit plus audit, audit-failure rollback, two competing writers producing one change/audit, lost-response read-only recovery and replay/already-valid refusal. The cluster was removed.
- Python syntax passed.
- `python3 controller.py --check`: `P07_TENANT_BINDING_PREPARATION_CHECK_PASSED_NO_ACTION`.
- `--run` and `--recover`: each refused `P07_TENANT_BINDING_REFUSED_WINDOW_NOT_BOUND` before hidden input or external access.
- Manifest/file count and private modes passed.

## Boundaries and next step

No application source, live database value, role/grant, secret/IAM binding, Stripe setting, destination, deployment, Checkout, payment, booking, customer contact, message, merge or push changed. Full Stripe Connect onboarding/configuration remains deferred beyond R1; this package is the finite setup correction only.

The next gate is an attended 45-minute Eastern block with Terminal, the current CHILD administrator password and signed-in Stripe Sandbox available. The implementer then binds exact times and package hashes, reruns the local suite and presents a separate external-operation proposal. That later proposal, not this preparation, would request one exact conditional tenant transaction with no retry. Destination/deployment readiness, P08 payment and 3A acceptance remain later gates.

Accepted progress remains **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. **No scope deviation from the approved prerequisite correction.**
