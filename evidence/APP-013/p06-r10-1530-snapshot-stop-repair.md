# P06 / R10 3:30 PM activation-snapshot stop and repair

## Section card — 2026-09-19

- Approved section/criterion: APP-013/P06/R10 requires the exact runtime approval and enabled zero-traffic revision to pass readback before the single capped R11 journey. R10 remains open.
- Source/evidence: backend `e6e2c86`, governance `10e4039`; owner-approved plan `9bd2c944-df82-437b-b89e-2e81cb7a53ad`; packet `37c3aa7e-4957-4fcd-83ac-d764e72dc6a8`; consumed activation operation `2e3b41a1-c90a-48d6-8a8e-bc1886386bde`.
- Demonstrated gap: the private controller captured `ACTIVATION_SNAPSHOT`, proving the transaction stopped while comparing its preflight snapshot with the locked tenant row. That code combined the row timestamp and approval pair into one stage, and the snapshot was captured before several slower read-only Cloud checks. It could neither identify which comparison failed nor safely tolerate unrelated timestamp movement before activation.
- Connected-workflow effect: R10 cannot deploy or hand off to R11 until activation commits and reads back. Refreshing the exact comparison immediately after the one-use reservation removes the stale preflight interval while retaining the transaction's compare-and-set refusal if state changes after the refresh.
- Reused interfaces: `executeR10ActivateBeforeDeploy`, the existing one-use reservation, fixed database transaction, approval-pair comparison, CAS update, audit, closeout and opaque stage collector. No application route, schema, provider adapter or customer interface is added.
- Behavior/files: `scripts/p06-r10-controller.mjs` now requires `refreshActivationSnapshot` immediately after `reserveActivation` and freezes the returned value passed to `activate`. `scripts/p06-runtime-packet.mjs` distinguishes `ACTIVATION_UPDATED_AT` from `ACTIVATION_APPROVALS` without exposing row data or raw errors. Controller and disposable-PG tests cover the added step and both fixed stage codes.
- State/identity/retention: the refreshed value remains private process state and is never returned to the user. Activation still locks the fixed tenant row and compares both timestamp and approval pair before any write. The reservation remains single use; closeout remains mandatory on every stop.
- Checklist/tests: successful refresh ordering; refresh failure containment; timestamp-drift stage; approval-drift stage; existing activation/readback/deployment/closeout paths; build, lint, architecture, private-input, governance and whitespace gates. No browser test applies to this local controller repair.
- Dependencies/approval: a future live attempt requires a fresh packet, revision, window, helper and exact owner approval. The consumed packet and operation cannot be retried. No current authority exists for LOGIN, activation, deployment, provider request, verification code or customer action.
- Exclusions/rollback: no schema/migration/dependency/route/module, secret/IAM/provider, deployment, participant binding, LOGIN or live database change. Reverting backend `1eff5ca` restores the prior preflight-snapshot controller behavior.
- Observable finish: a fresh private controller can collect the comparison snapshot immediately before activation and, if activation still stops, retain only the exact fixed timestamp or approval stage. R10 itself remains incomplete.

## Approved attempt result

The bounded LOGIN opened at `2026-09-19T19:47:56.061Z` with role OID `163840`, connection limit `10`, expiry `2026-09-19T20:00:00.000Z` and zero sessions. Activation was exclusively reserved at `2026-09-19T19:48:55.237Z`. The only retained operation stage is `ACTIVATION_SNAPSHOT`; there is no activation result, deployment reservation or deployment result.

The controller stopped at `ACTIVATE` and completed mandatory containment with `closeoutStatus: CLOSED` at `2026-09-19T19:48:57.860Z`. Independent authorized read-only Cloud Run confirmation found normal traffic unchanged at 100% on `signmons-calldesk-staging-app013bounds`, the disabled candidate still latest Ready, and the proposed enabled6 revision/tag absent.

Therefore this attempt made no activation write, deployment, provider request, verification-code request, address request, browser journey, reviewed submission, job or customer contact. The operation is consumed and was not retried.

## Local repair validation

- `node scripts/verify-p06-runtime-packet.mjs` — 16 disposable PostgreSQL 18 checks passed against all 26 migrations; zero live provider calls and zero live secret calls. The verifier distinguishes `ACTIVATION_UPDATED_AT` and `ACTIVATION_APPROVALS` and preserves rollback/concurrency behavior.
- `node --test scripts/p06*.test.mjs` — 80 passed, two expected local-PG skips.
- `python3 -m unittest scripts/test_p06_private_diagnostic.py scripts/test_p06_private_input.py` — 15 passed.
- `npm run build`, `npm run lint`, `npm run arch:check`, Prettier and `git diff --check` — passed.

Backend repair commit: `1eff5ca`. P06 remains 11/14 with R10/R11/R12 open. Original dirty APP-010 checkout preserved. No scope deviation.
