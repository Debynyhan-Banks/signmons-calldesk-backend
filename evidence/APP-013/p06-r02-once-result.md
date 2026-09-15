# R02 one-shot execution wiring — 2026-09-15

Owner explicitly reviewed/approved the fixed wiring proposal and said proceed. Entry backend d4dad75/governance27c8b11, fetched focused remotes clean; saved checkout unrelated changes preserved. Pre-code approved card in APP013_P06_R02_COMMAND_AUDIT.md. No live Neon access/credentials/export, image mount, migration or deployment.

## Implemented

- scripts/p06-backup-once.mjs: fixed-target CLI accepts only the private approval.json path; exact target/revision/clean-checkout/UTC/fresh-quota assertions; mounted-image UUID/outer encryption/ownership/exclusion/storage verification; private scoped passfile parsing; persistent exclusive attempt marker; TLS-verified source and restricted role/expiry/no-other-session checks.
- Same exported backupCore uses existing BackupBudget/compareTables/sameMetadata: read-only repeatable-read source,13 checksums,26-table allowlist, retained exported snapshot, one custom archive, one transactional local restore, all-table comparison and both-schema column/constraint/index/type/trigger/function/owner/ACL/default-ACL/extension comparison. No source fixture generation, business-data write or migration path in CLI.
- Private local PG18 cluster under the run directory, metadata-only NOLOGIN role stand-ins, explicit extension owner; all real artifacts remain encrypted, including local restored data/log. Same7day retention applies to run contents; dump completion anchors success expiry, approved start anchors partial retention. No silent retry or attempt-marker reset.
- Local cleanup closes connections, stops owned local server, removes the same inode passfile, validates/ejects exact image. Does not eject after server-stop failure. Fixed codes; no driver error payloads, row output or passwords. Administrator NOLOGIN/session termination remains REQUIRED as a separately authorized console closeout, never automated using a parent credential.
- APP013_P06_R02_RUNBOOK.md gives the exact command, packet fields, conditional owner-assisted handoff, stop rules and independent administrator revocation/readback SQL.

## Actual tests

20 Node tests passed (7new entry-point tests plus13 existing guard tests);4 private-input regressions passed. Packet/target/revision/date/allowance refusal, scoped secret parsing/private file checks, concurrent exclusive marker, no-argument CLI refusal before network, same-core sequence/read-only source SQL, identity/history/source IO/dump/restore/legacy metadata/row mismatches, independent cleanup actions and no running-server ejection. Existing deadline/storage/signal/private-comparison tests retained.

Existing local PG18.6 managed-role migration rehearsal extended to invoke the exact new backupCore through a restricted local reader, actual pg_dump/pg_restore and both-schema metadata comparison. Passed26tables/20fictional rows plus all previous snapshot/concurrent-write/mismatch/oversize/missing-role/truncation/migration/no-op/constraint/lock-timeout tests. Report /private/tmp/signmons-p06-upgrade-iwygvv/report.json. New same-core archive is same-core.dump; original rehearsal archive119800bytes SHA256a5fef5f902bd7fffec18df7935ef2854c7d03d52781d7d7c7bedfbf322eaaabd. Report precedes the output-only addition of dumpCompletedUtc/retention timestamps; updated unit tests passed afterward.

Seven generated databases and six created roles removed. Fresh checks returned0fixture databases and0fixture/stand-in roles. Private no-TCP cluster /private/tmp/signmons-pg18-YjyVW4 stopped successfully. Fictional retained artifacts only.

Lint/build/architecture passed. Touched-JS syntax/Prettier and full governance/frozen/21regression/whitespace gates apply. No UI change, browser QA not applicable; no full app Jest rerun claimed.

## Evidence limits / review

Actual integration proves the shared backup core on local PG. The fixed live adapter's Neon TLS/account/Console reset and mounted-image init/start/eject combination has not been exercised with a real credential. Tests use mocks for failure orchestration and local fixtures for real database operations; do not label either live recovery. Previous ownership-enabled mounted-input proof remains valid, not rerun.

Packet fields record operator approval/attestations, not cryptographic authorization or automated billing verification. Source quota/session readback still required at actual run. Workspace monitor permits scan/event-loop overshoot and is not a filesystem quota. Cleanup can fail; encrypted result.json has localCleanup PENDING before ejection; returned PASSED establishes local cleanup only, never administrator revocation. A preflight refusal before the attempt leaves pre-existing passfile/image for explicit operator closeout. No forensic memory or administrator-protection claim.

Review scripts/p06-backup-once.mjs, its tests and the runbook; verify source has no write/migration path, target is fixed, packet cannot silently extend its window, and cleanup/administrator gates are distinct. Next is review and an explicitly authorized, freshly bound real credential/backup packet—not another standalone rehearsal. Actual recovery and remaining migration-access/consumer requirements must be reconciled before R02 acceptance; R03/R04 stay separate.

R01 closed,R02-R12 open11,added0; accepted5/60packages and3/8walkthrough unchanged; ETA unvalidated. No scope deviation.
