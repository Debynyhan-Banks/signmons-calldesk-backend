# P06-R02 authorized live-test preflight and safe stop — 2026-09-15

## Authority and fixed scope

Owner explicitly said "approve the live staging backup test" after the exact two-role, private handoff, one20minute backup/restore and mandatory closeout/seven-day retention packet was presented. Entry backend d89f20e7766f86974459a8c761d0787f000b110c/governance972d1d9; focused remotes fetched, clean and unchanged. Backend PR21 still open at that SHA. Saved backend unrelated changes preserved. No scope deviation, new task, migration, deployment or production action.

## Fresh preflight

- Correct existing child br-sparkling-sun-ay6gr5e8 / p06-isolated-staging-v1 in project soft-smoke-54063480, direct endpoint ep-jolly-flower-ayc6w9hv, neondb. PG18.6,11,165,696bytes,26tables across public/legacy_2025, all owned by neondb_owner.13 successful migration names/checksums match the local first13 manifest. Other source sessions0; proposed role collisions0 before creation.
- Neon dashboard readback1.89/100CUh,0.04/0.5GBstorage,0/5GBtransfer,2/10branches; child fixed0.25CU. UI explicitly warns usage may lag an hour, not a real-time billing guarantee. Known nine tagged Cloud Run revisions plus migration job still reference signmons-staging-database-url:latest; versions2enabled/1disabled. No payloads read, new app bindings or consumer changes. This is known-consumer metadata plus point-in-time zero sessions, not proof against all undiscovered clients.
- Existing exact encrypted image mounted, UUID/OwnersEnabled/encryption/TimeMachine exclusion/free-space guards passed via inspectStorage. New exclusive r02-backup-v1 directory current-owner0700; non-secret approval.json0600. No previous directory adopted or removed.
- Approval ID P06-R02-20260915-1222-live-v1; window2026-09-15T12:22:00.000Z through12:42:00.000Z announced before mutation. Remaining allowance recorded98.11CUh/5,000,000,000bytes from dashboard. Packet is an operator record, not a hard spending cap.

## Actual mutation and readback

Executed exactly the approved child-console transaction from APP013_P06_R02_EXECUTION_PROPOSAL.md: created p06_migration_owner and p06_migration_runner initiallyNOLOGIN; runner CONNECT onneondb, USAGE onpublic/legacy_2025 and SELECT onexact26tables. COMMIT success observed. No password literal/reset, managed-role membership, schema/object ownership transfer, write grant or migration.

Readback: both roles rolcanlogin/rolsuper/rolcreatedb/rolcreaterole/rolreplication/rolbypassrls=false, memberships0. Runner readable tables26 and aggregate no INSERT/UPDATE/DELETE/TRUNCATE=true. Roles remain as disabled prepared identities; they were not dropped. No new-role password was issued by this work.

## Demonstrated blocker / stop

Neon child Roles page showed only inherited neondb_owner. Revisited through SQL Editor back to Roles and still no p06_migration_runner or p06_migration_owner row. SQL catalog proves creation, but the Console reset path required by the reviewed runbook is unavailable in the observed UI. Cause is not established: do not claim caching or NOLOGIN filtering as proven.

Runbook explicitly requires stop if the new-role action cannot be verified. No reset of neondb_owner, no enabling LOGIN to force visibility, no alternate administrator credential and no real executor attempt. Thus this is NOT a failed dump/restore and NOT a live recovery pass. No private input requested from owner.

## Safe closeout

Final SQL readback both roles stillNOLOGIN, all restricted flags false, sessions0 for each. No LOGIN was granted, so no revocation or session-termination mutation was needed. Before eject: pgpass,attempt.json,source.dump,data all ABSENT. No local PG server created. Non-secret closeout.json0600 records stopped-before-handoff and windowCancelled. Exact verified image /dev/disk4 ejected; mount absent and hdiutil no images. Existing unrelated encrypted fixture artifacts preserved.

Approved window cancelled; do not silently reuse directory/approval, reset an attempt marker or extend time. Private packet/closeout records only retained within existing encrypted image until2026-09-22T12:22:00.000Z; no customer backup exists. Deletion/extension remains separately authorized. No retention automation created.

## Next / validation / acceptance

Next bounded work is read-only qualification of a secure issuance route for the already-created restricted child runner, not another synthetic backup rehearsal. Any change to NOLOGIN-before-handoff ordering or credential mechanism requires explicit reviewed amendment before mutation. Preserve inherited password and source ownership. Real backup/restore plus remaining R02 access criteria are still open; R03/R04 stay separate.

Frozen/full consistency passed before actions. Post-documentation frozen/full cross-repository consistency,21governance regressions, architecture and whitespace checks recorded with this checkpoint. No source code changed; no new application lint/build/Jest or fixture proof claimed. Actual browser QA is the observed transaction/readback/Console limitation, not an application test.

R01closed;R02–R12open11;added0. Accepted remaining-plan packages5/60(8.3%),walkthrough3/8(37.5%); not overall engineering completion. R02/P06unaccepted; ETAunvalidated. No scope deviation.
