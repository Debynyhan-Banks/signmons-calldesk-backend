# APP-013 / 3A / P07 connected-account handoff repair local preparation

Date: October 22, 2026, Eastern time

## Scope and traceability

- Section: R1-W01 / APP-013/3A/P07.
- Unchanged criterion: the accepted job opens one authorized Stripe Sandbox Checkout from its approved payment policy, and only an authentic signed event for its exact stored Stripe resource may clear the payment gate.
- Demonstrated gap: consumed operation `aff460dd-740b-40c4-8fcc-ea6dbc21057e` stopped before database access because the matching valid-format hidden input did not hash-match the one enabled connected account qualified from Stripe.
- Owner authority: Debynyhan Banks approved Alternative 1 in governance `APP013_P07_CONNECTED_ACCOUNT_HANDOFF_REPAIR_PROPOSAL_20261022.md` for local preparation/testing only.
- Customer-workflow connection: unambiguous binding to the enabled Sandbox account is required before policy enforcement can create Checkout and webhook truth can settle the same job.

## Fresh disabled package

Package: `/private/tmp/p07-tenant-stripe-binding-handoff-repair-20261022-prep1`.

- plan `0add40ae-f062-417f-8cab-aa7b7943f562`;
- packet `c1ba7f8c-8e93-4264-9551-02072df99f7e`;
- operation `bfc0bb5b-1564-4991-a446-3960caa67d49`;
- audit ID `12e35d90-4e71-44ee-baf6-d2195ea96699`;
- controller SHA-256 `1fbe7d426125a5f8c6a62c0be367c95fe42cd66d18f9004995ad19916f6bca36`;
- manifest SHA-256 `0f24d31b7dcb565fceb8396fe465ca297ae0685641725c403da006a6db36a55d`.

The private mode-0700 directory contains exactly seven mode-0600 files. It has no binding, window, owner live approval, Stripe receipt, attempt, mutation intent, result or stop receipt. `--run` and `--recover` both refuse `P07_TENANT_BINDING_REFUSED_WINDOW_NOT_BOUND` before hidden input or external access.

## Preserved behavior and repaired handoff

The reviewed preflight, exact tenant/job predicates, serializable conditional update, same-transaction audit, separate readback, read-only uncertain-commit recovery, deadlines, no-retry behavior and receipt shapes are unchanged. The later attended procedure is now explicit: the owner enters only the current CHILD administrator password; after preflight, the automation reads the ID only from the unique Enabled connected-account row and types it directly into both existing hidden prompts. The raw value may exist only in volatile browser/controller process memory and SQL stdin and must be cleared after the second entry. Chat, clipboard, files, environment variables, arguments, logs, exceptions, receipts, audit metadata and screenshots are forbidden raw-ID channels.

## Local verification

- Controller regressions: 14/14 passed.
- Handoff boundary checks: 2/2 passed. They require both existing double-entry hidden prompt pairs and the attended unique-Enabled-row contract, and forbid added clipboard/environment/plain-input channels or raw persistence routes.
- Disposable PostgreSQL 16.11: 5/5 passed using synthetic rows and a temporary Unix-socket-only cluster. The cases prove exact commit/audit, audit-failure rollback, competing writers allowing one change, lost-response read-only recovery and replay/already-valid refusal. The cluster was removed. The first sandboxed initialization was blocked by local shared-memory policy before a cluster existed; the exact approved test was rerun outside that sandbox and passed.
- Python syntax passed.
- `python3 controller.py --check`: `P07_TENANT_BINDING_PREPARATION_CHECK_PASSED_NO_ACTION`.
- `--run` and `--recover`: each refused `P07_TENANT_BINDING_REFUSED_WINDOW_NOT_BOUND`.
- Exact inventory, manifest hashes, private modes and absence of operation receipts passed.

## Boundaries and next step

No application source, browser, live database, tenant value, role/grant, secret/IAM, Stripe setting, destination, deployment, Checkout, payment, booking, customer contact, message, merge or push changed. The consumed package remains untouched.

The next input is an attended 45-minute Eastern block with Terminal, the current CHILD administrator password and the signed-in Stripe Sandbox available. The implementer then binds exact times and hashes, reruns the local suite and presents a separate exact external-operation proposal. The in-memory handoff, database access and tenant mutation remain unauthorized until that later approval.

Accepted progress remains **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. P07/3A remains active and not live-demonstrated. **No scope deviation.**
