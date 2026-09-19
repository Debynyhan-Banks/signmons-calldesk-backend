# P06 / R10 activation operation stage evidence

## Section card — 2026-09-19

- Approved section/criterion: APP-013/P06/R10 requires exact runtime approval and enabled-revision readback before R11. R10 is still open.
- Source/evidence: backend `ca72cc7`, governance `11908fd`; the consumed activation stopped at undifferentiated `ACTIVATE`, while the approved read-only diagnostic passed every persistent prerequisite it covered.
- Missing behavior: `operate` deliberately reduced every failure to `P06_PACKET_REFUSED_OR_UNCONFIRMED`, leaving no safe way for the private controller to distinguish connection/transaction, migration, preflight snapshot, current-policy, final-window, update-CAS or audit stages. Repeating a live packet without that evidence would not advance the connected workflow responsibly.
- Reused components: the existing `operate` implementation, fixed database handle, transaction, packet/authorization guards and synthetic PG18 verifier. No new database query, route, startup integration or external adapter is introduced.
- Behavior/files: `scripts/p06-runtime-packet.mjs` now has an optional opaque single-use stage collector and `operateWithStageEvidence`; existing `operate` still returns the same generic error and no stage property. The collector accepts only a closed fixed-code set and exposes no exception, row, identifier, setting or credential. `scripts/p06-runtime-packet.test.mjs` covers opacity/single use/generic errors. `scripts/verify-p06-runtime-packet.mjs` proves a real disposable-PG18 approved-policy mismatch reports `CURRENT_STATE_AUTHORITY` while transaction rollback and existing paths remain intact.
- State/identity/retention: stage evidence exists only in process memory unless a separately reviewed private controller writes the fixed code. It carries no customer/participant data and does not change database state. The existing transaction, CAS, audit and rollback semantics are unchanged.
- Checklist/tests: generic existing API preserved; fixed stage set; opaque single-use collector; negative invalid-handle classification; real PG18 authority-refusal classification; existing concurrency/recovery/runtime packet suites; build/lint/architecture/governance/whitespace checks. No browser test applies to this inert operator interface.
- Dependencies/approval: a future live activation remains separately gated by a fresh packet/window and owner approval. This change creates no authorization to connect, activate, deploy, call providers or run R11.
- Exclusions/rollback: no schema, migration, dependency, route/module, secrets/IAM, provider, deployment, LOGIN, customer/job or release change. Reverting this commit restores the prior generic-only operator interface.
- Observable finish: a future private controller can persist only the last safe stage after a stopped activation, removing the need for another blind diagnostic. R10 itself remains incomplete.

## Validation

- `node --test scripts/p06-runtime-packet.test.mjs scripts/p06-r10-activation-diagnostic.test.mjs scripts/p06-r10-controller.test.mjs` — 33 passed.
- `node scripts/verify-p06-runtime-packet.mjs` — 15 disposable PG18 checks passed, 26 real schema migrations, zero live provider/secret calls.
- `node --test scripts/p06*.test.mjs` — 79 passed, two expected local-PG skips.
- `python3 -m unittest scripts/test_p06_private_diagnostic.py scripts/test_p06_private_input.py` — 15 passed.
- `npm run build`, `npm run lint`, `npm run arch:check`, governance baseline and `git diff --check` — passed.

The first sandboxed disposable-PG invocation could not initialize its local cluster; the same repository verifier was rerun with the required local-process permission and passed completely. This was local-only and made no network/provider call.

No database connection, activation, deployment, provider request or customer action occurred during this change. P06 remains 11/14 with R10/R11/R12 open. Original dirty APP-010 checkout preserved. No scope deviation.
