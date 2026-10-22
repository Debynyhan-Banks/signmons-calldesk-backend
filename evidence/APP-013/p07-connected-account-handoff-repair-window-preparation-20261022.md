# APP-013 / 3A / P07 connected-account handoff repair window preparation

Date: October 22, 2026, Eastern time

## Exact binding

- Section: R1-W01 / APP-013/3A/P07.
- Package: `/private/tmp/p07-tenant-stripe-binding-handoff-repair-20261022-prep1`.
- Plan: `0add40ae-f062-417f-8cab-aa7b7943f562`.
- Packet: `c1ba7f8c-8e93-4264-9551-02072df99f7e`.
- Operation: `bfc0bb5b-1564-4991-a446-3960caa67d49`.
- Preparation manifest: `0f24d31b7dcb565fceb8396fe465ca297ae0685641725c403da006a6db36a55d`.
- Bound manifest: `1b9dd0a8b12966e460f8d84c8c72c405ff2b433339d64b34849c1310deb55b76`.
- Binding: `c7b3e40f8311ad48e653f6ea9b5d8e03d058bbf5715411745a7a24601def21bd`.
- Controller: `1b5b33ff377d312958fd70fbe4959555508d6d40b2c871367ad89b75017da200`.
- Window: October 22, 2026, 7:45–8:30 a.m. Eastern.
- Strict start cutoff: 7:55 a.m.
- Mutation deadline: 8:15 a.m.
- Closeout deadline: 8:25 a.m.
- Automatic retry: false.
- Cost allowance: USD 0.

## Bound behavior

The existing reviewed tenant preflight, serializable conditional update, same-transaction audit, separate readback, read-only uncertain-commit recovery and mandatory closeout remain unchanged. Exact approval validation now names the direct in-memory connected-account handoff in addition to read-only Stripe qualification, the tenant-binding transaction and sanitized closeout.

During an approved operation, Debynyhan Banks enters only the current CHILD administrator password. After `P07_TENANT_BINDING_STRIPE_PREFLIGHT_READY`, the automation may read the identifier only from the unique Enabled row on Stripe's Connected accounts page and type the volatile value directly into both hidden Terminal prompts. It must not enter chat, clipboard, files, environment variables, command arguments, logs, exceptions, receipts, audit metadata or screenshots and must be cleared after the second entry.

## Verification after binding

- Controller regressions: 14/14 passed.
- Handoff-boundary checks: 2/2 passed.
- Disposable PostgreSQL 16.11: 5/5 passed.
- Python syntax, exact eight-file inventory, private modes and manifest hashes passed.
- `python3 controller.py --check`: `P07_TENANT_BINDING_PREPARATION_CHECK_PASSED_NO_ACTION`.
- `--run` and `--recover`: each refused `P07_TENANT_BINDING_REFUSED_OWNER_APPROVAL_INVALID` before hidden input or external access.

No browser, live database, tenant mutation, role/grant, secret/IAM, Stripe change, destination, deployment, Checkout, payment, booking, message, merge or push occurred. The package is bound but disabled. Governance `APP013_P07_CONNECTED_ACCOUNT_HANDOFF_OPERATION_PROPOSAL_20261022.md` is the separate external-operation decision.

Accepted progress remains **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. **No scope deviation.**
