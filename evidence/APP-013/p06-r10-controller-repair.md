# P06 / R10 activate-before-deploy controller repair

## Authority and result — 2026-09-18

The owner approved `APP013_P06_R10_SEQUENCE_CHANGE_REQUEST.md` alternative 1 for local controller repair and testing only, expressly excluding deployment, database LOGIN, activation, provider requests, verification codes and execution until a fresh exact packet/window receives separate approval.

Local implementation is complete and review-ready from entry backend `08a9e8ea56684c7eb90e3e085d222ce23c53fd6a` / governance `e211e77`. Added only:

- `scripts/p06-r10-controller.mjs`
- `scripts/p06-r10-controller.test.mjs`
- this evidence

No production runtime, schema, migration, dependency, image or private packet was changed. The module has no CLI and performs no action on import. It contains no provider/database client, command execution, credential, phone, address, participant binding or secret-store access; every external operation is an injected port for a future separately approved private wrapper.

## Implemented boundary

- Strict plan review rejects the consumed first-attempt plan/revision, malformed digests/IDs, a non-reviewed tag/origin, noncanonical timestamps, runtime longer than 15 minutes and closeout longer than 15 additional minutes.
- Execution requires the current time plus configured reserve to fit inside the runtime window. The success order is fixed: exact inactive preflight -> one activation reservation -> one activation -> exact activation readback -> one deployment reservation -> one zero-traffic deployment -> exact deployment readback. Only then may it return `READY_FOR_R11`.
- Deployment readback requires the new revision/tag/origin, target traffic 0 and normal traffic 100% on `app013bounds`.
- Any stop after a possibly committed activation performs read-only approval reconciliation. Only the exact active runtime/phone digests may be revoked. Revocation/readback precedes enabled-tag removal; tag removal precedes runtime-role shutdown; final readback requires approval inactive, tag absent, role `NOLOGIN`/limit0/sessions0 and normal traffic unchanged.
- Unknown or foreign approval state is never guessed or overwritten. The controller still attempts tag/runtime containment and reports `UNCONFIRMED` unless final readback proves the full closed state. Each mutation port is called at most once; ambiguous outcomes are reconciled, never replayed.
- `reserveR10Operation` creates an exclusive, fsynced mode-0600 record and refuses reuse. The controller exposes only sanitized stop stage/closeout status and does not attach private causes.

## Validation

- Focused controller: 21/21 tests pass. Coverage includes success ordering, activation and deployment readback mismatch, activation/deployment throws, confirmed inactive and unknown activation outcomes, revoke/readback/tag/runtime/final-readback ambiguity, explicit active/inactive closeout, preflight mismatch, expired/not-started/overlong/misaligned windows, consumed plan/revision, exclusive reservation and at-most-once mutation assertions.
- Combined Node operator/controller/migration suites: 37/37 pass.
- Disposable PostgreSQL 18 U01 verifier: 14 checks pass; 26 schema migrations; zero live provider/secret calls; owned cluster removed/stopped.
- Full Jest: 129 suites passed, one existing suite skipped; 2,359 tests passed, three existing tests skipped.
- Build, lint, architecture, Prisma validation, controller Prettier check and whitespace check pass. Direct module import exits 0 with zero stdout/stderr.
- Complete disposable PostgreSQL 18/browser harness passes. It includes actual restricted runtime identity with 13 negative permission cases, current approval reader/startup/revocation/retirement, shared phone/browser budgets, eight loaded browser cases at 390/1440, protected customer/operator review and exactly-once synthetic admission paths. It reports zero live provider calls and cleans its owned fixture database/cluster.
- Initial sandbox runs failed only because PostgreSQL shared memory and localhost listeners were denied; equivalent approved local runs outside the sandbox passed. The first browser pass also exposed missing ignored `ui/out`; the pinned UI lockfile was installed with zero audit findings and the static UI built. A default `/tmp` PostgreSQL server then failed the intentional PG18 guard; the final run used the required owned PG18 Unix-socket cluster. No guard or expected result was weakened.
- Required governance frozen baseline, cross-repository consistency and 21 governance tests must be rerun after the synchronized completion update and commit.

## Handoff

The controller defect is locally repaired; this is not R10 completion or live qualification. P06 remains 11/14 and R10/R11/R12 remain open. No fresh packet, revision, digest, origin binding, window, authorization or private helper was created. Next is a separately authorized fresh-packet preparation/review using current provider/target state, followed by a separate exact execution approval. No external action is inherited from this local result.

Approved sequence deviation only; no other scope deviation.
