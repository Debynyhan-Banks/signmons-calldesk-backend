# R02 stalled private input — local repair

2026-09-15, entry8da585c/governance1e0cac2. User said proceed to fixing the stalled private prompt. Same approved R02 recovery workflow; no new acceptance area or provider dependency. Focused origins fetched, saved work preserved. No scope deviation.

Prior supervised attempt: P06-R02-admin-backup-20260915T133406Z cancelled. At closeout only approval.json/attempt.json observed in admin-v1, no pgpass/source.dump/result.json; closeout.json then recorded cancellation, Python48632/Node48633 stopped, exactdisk4 image ejected and mount absent. These are prior-turn observations; no claim whether the owner typed a password into the private terminal. No credential material was inspected. No completed backup or recovery evidence. Preserve cancelled records; no marker reset or retry in this repair.

Cause in source: backup CLI top-level awaits runLive; runLive awaited dynamic import of password helper to get readPipe; that helper statically imports the still-evaluating backup entry module. This creates a circular evaluation wait before the reader executes. Existing unit tests imported the CLI as an already evaluated library; Python tests used a simple substitute child. That test gap is ours, not a Neon fault.

Correction: move the same readPipe implementation to existing p06_backup_guards.mjs; both helpers statically import it, old helper re-exports it for compatibility. No new module/dependency, credential operation or altered target/role. Python READY protocol now bounds the complete line, not just first-byte readiness; a partial response cannot cause unbounded readline. All backup/auth/storage/retention/single-attempt controls preserved.

Regression evidence: new live-entry local dependency traversal failed on original source with circular dependency p06-backup-once.mjs, then passed after repair. Additional hidden PythonTTY→actualNode readPipe test passes with dummy canary; cancellation, timeout and termination produce no canary output and restore terminal mode. Partial READY times out within its bound. This is actual local process transport and static dependency testing, not full live CLI/Neon authentication or database restore.

Current focused results:33Node passed,1 prior opt-in local password-assignment database integration skipped;10Python passed. No repeated synthetic full backup or application browser test; no app UI/runtime change. No live credential, mount, Neon configuration, source SQL, export, migration or release performed this turn.

Additional validation passed: lint/build/Prisma generation, architecture, JS syntax/Prettier, backend governance check, frozen/full governance consistency,21 governance regressions and whitespace in both repositories. No dependency upgrades applied.

Next: fresh supervised retry authorization, unused fixed path/current SHA/window packet and owner private readiness; never reuse admin-v1. Recovery remains unproven; migration-access area remains separate. R02 has two acceptance areas; R01closed/R02-R12open11/added0; accepted5/60 tracked packages and3/8 walkthrough unchanged; ETAunvalidated.
