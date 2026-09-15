# P06-R02 synthetic backup/restore result

Owner approved synthetic restore testing and private-storage packet. Entry backend2cf7e00/governanceb0c0ec1. Extended existing scripts/verify-p06-migration-upgrade.mjs behind P06_BACKUP_REHEARSAL=1, which refuses default /tmp socket and requires existing validated private PostgreSQL18 socket. No external URL accepted; Postgres tools use a minimal environment with explicit local socket. Runtime/migration SQL unchanged.

Executed: P06_PG18_SOCKET=/private/tmp/signmons-pg18-pgScL8/socket P06_BACKUP_REHEARSAL=1 node scripts/verify-p06-migration-upgrade.mjs.

Passed PostgreSQL18 synthetic full custom archive -> empty restore: all13 migration records/checksums, all rows in five populated fixture/history tables, catalog and table/sequence owner/ACL metadata match. No --no-owner/--no-acl suppression. Truncated archive exits1 under single-transaction restore; empty target retains zero public tables. Archive112991bytes, SHA2567addf0027b03777f3f34113d9cf19339cb3c6c44e766094c284e21c2b3b5e286. Report /private/tmp/signmons-p06-upgrade-pM0yN4/report.json; synthetic artifacts retained, not encrypted and not suitable storage for real data.

Existing full upgrade26, row preservation, constraints/revision/nullability, immutable policy, no-op replay and5s lock-timeout failure checks passed. Catalog parity counts423 columns,481 constraints (PG18 catalog includes NOT NULL),154 indexes,10 triggers,7 functions,134 enum labels. Five generated databases were removed by tracked-name cleanup; private no-TCP PostgreSQL18 server stopped and status confirmed no server running. Existing other databases/services untouched.

Limits: same local owner exists in source/destination; not independent role-bootstrap, least-privilege migration or Neon managed-extension proof. No encrypted-storage test, live archive, Neon connection or recovery performed. Synthetic fixtures only. Full app unit suite not rerun for test-script-only change; build/lint/architecture and governance/whitespace gates run. Browser QA not applicable, no UI change. Private-storage draft is governance APP013_P06_PRIVATE_BACKUP_PACKET.md.

R01 closed, R02 partial; R02-R12 open11,added0. Accepted5/60 (8.3%), walkthrough3/8 (37.5%), ETA unvalidated. Next remaining result: validated encrypted storage and exact credential/metadata proposal before real-data approval. No scope deviation.
