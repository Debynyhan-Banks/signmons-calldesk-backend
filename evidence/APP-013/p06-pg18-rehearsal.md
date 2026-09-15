# P06-R02 PostgreSQL18 compatibility rehearsal

Owner explicitly approved local PostgreSQL18 installation and isolated synthetic rehearsal. Entry backend99f4a45/governance38b5bae; pre-action card APP013_P06_R02_PG18_CARD.md. Existing R01 remains closed; this addresses R02's known server-major gap, not an added task. No scope deviation.

## Installation and isolation

Homebrew core supplied PostgreSQL18.6 (77.7MB keg). Installed with automatic update/cleanup/dependent checks disabled and --skip-post-install; no dependency installs reported, no forced linking, PATH edits, login service or default cluster. The unavailable Stripe Directory CLI was not installed/upgraded; Homebrew formula metadata provided the installation path.

Skipped post-install omitted required support links. Initial initdb failed on missing postgres.bki, then explicit -L exposed missing timezone directory; initdb removed its own failed temporary data directory. Created only previously absent version18-specific share/lib links to this keg, corresponding to formula installation support paths; no version16/17 links overwritten. Successful initdb followed. No trust settings for unrelated taps changed.

Owned cluster /private/tmp/signmons-pg18-pgScL8/data; private0700 socket directory; host authentication reject, local socket trust bounded by private directory, listen_addresses empty (confirmed). No TCP listener. No real credentials/data or cloud operations. Default PG18 cluster /opt/homebrew/var/postgresql@18 not created.

## Results

Prisma7.10.0 and the unchanged26 migration inputs passed the existing complete rehearsal on PostgreSQL18.6: old13→all26 upgrade; existing fictional row preservation; consent revision default/increment, nullable fields, CHECK/UNIQUE/FK and immutable policy refusal; no-op repeat; catalog parity with fresh database; intentional lock-timeout leaves prior23 successful and24th unfinished without blind retry. All three owned rehearsal databases removed. Exact report /private/tmp/signmons-p06-upgrade-hyghoz/report.json and checksummed manifest/deploy logs; outer log /private/tmp/signmons-pg18-pgScL8/rehearsal.log. No claim this validates Neon extensions/pooler/actual target minor version or baseline application readers.

Temporary18 server stopped; pg_ctl confirms no server running. Existing /tmp PostgreSQL16.11 still reports same version. Its default-path rehearsal regression also passed and removed only its generated databases. Stopped synthetic cluster retained (~55MB) with logs for review; installed binary remains, no background service.

Script change: optional P06_PG18_SOCKET constrained to private owned real /private/tmp/signmons-pg18-*/socket; no symlink path or remote URL, requires major18 before creating a DB. Default socket stays /tmp. Three invalid/remote/traversal input cases refused before database access. Uses same actual migration assertions, no schema or runtime change.

Build/lint passed;2359 unit tests passed,3 skipped (129 suites passed,1 skipped); syntax and architecture passed; both default16 and isolated18 rehearsal passed. Governance frozen/full consistency,21 regressions, backend governance and whitespace passed. No new browser claim: no application/UI change; previous browser evidence remains historical. No new dependency audit claim.

Reproduce using the approved card: create an owned private temporary18 cluster/socket with TCP disabled; run P06_PG18_SOCKET=<owned socket> node scripts/verify-p06-migration-upgrade.mjs; stop that exact cluster. Binary path /opt/homebrew/Cellar/postgresql@18/18.6/bin. Do not point it at staging or upgrade an existing database. Build/unit logs /private/tmp/signmons-p06-r02-{build,lint,tests}.log; default regression log /private/tmp/signmons-p06-r02-default.log.

## Remaining

R02 remains OPEN for authoritative migration connection, baseline/tagged-consumer compatibility and write isolation, plus fresh usable recovery checkpoint/expiry/restore ownership. Six-hour history is not an exercised restore; no backup or maintenance action approved here. Closed R01; open R02–R12:11 tasks, added0. Accepted5/60 packages and3/8 walkthrough unchanged; ETA unvalidated. Next is the existing R02 recovery/consumer plan and qualification, not migration execution or another package.
