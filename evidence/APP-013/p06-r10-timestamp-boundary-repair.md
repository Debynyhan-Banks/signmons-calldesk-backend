# P06 / R10 activation timestamp-boundary repair

## Section card — 2026-09-19

- Approved section/change: APP-013/P06/R10 and owner-approved `APP013_P06_R10_TIMESTAMP_CHANGE_REQUEST.md` alternative 1, local repair and testing only.
- Acceptance criterion: activation must refuse changed/active/partial controlled approvals before writing while preserving the locked-row current-authority checks, transactional `updatedAt` compare-and-set, audit, rollback, readback, concurrency and no-retry behavior.
- Source/evidence: backend `45fd833`; the consumed 4:05 PM attempt returned `ACTIVATION_UPDATED_AT` after the snapshot was refreshed immediately before the locked transaction, proving the broad tenant-row timestamp was not a stable activation-authority boundary.
- Connected-workflow effect: the activation precheck now follows the actual controlled runtime/phone authority. Unrelated tenant-row timestamp movement cannot block R10, while approval drift still stops before activation.
- Reused interfaces/files: `scripts/p06-runtime-packet.mjs`, controller tests and the disposable-PG18 verifier. No route, schema, migration, dependency, provider adapter or customer interface changed.
- Behavior: activation expected input is now exactly `{approvals:{runtime,phone}}`. `ACTIVATION_APPROVALS` remains a fixed safe stage. Tenant status and organization/payment/category authority are still checked from current locked transaction state. The write still uses `updateMany({id,updatedAt})` under the row lock and requires exactly one row before committing its audit.
- Boundaries: the repair contains no participant/customer data and grants no packet, LOGIN, activation, deployment, provider request, verification code or execution authority.
- Tests: unrelated timestamp movement proceeds to the intended current-authority check; changed approvals refuse at `ACTIVATION_APPROVALS`; concurrent writers commit once; stale/active/foreign/replay paths refuse; audit failure rolls back; controller failure closes without retry.
- Rollback: revert backend `f254c4f`. P06 acceptance and task count are unchanged.

## Validation

- `node scripts/verify-p06-runtime-packet.mjs` — 16 disposable PostgreSQL 18 checks passed against all 26 migrations; zero live provider/secret calls.
- `node --test scripts/p06*.test.mjs` — 80 passed, two expected local-PG skips.
- `python3 -m unittest scripts/test_p06_private_diagnostic.py scripts/test_p06_private_input.py` — 15 passed.
- `npm run build`, `npm run lint`, `npm run arch:check`, focused tests, Prettier and `git diff --check` — passed.

No live database connection, packet, LOGIN change, activation, deployment, provider request or customer action occurred during this repair. P06 remains 11/14 with R10/R11/R12 open. A future attempt requires a fresh packet/revision/window, a helper implementing the approval-only snapshot shape, and separate exact owner approval. Original dirty APP-010 checkout preserved. Approved change only; no other scope deviation.
