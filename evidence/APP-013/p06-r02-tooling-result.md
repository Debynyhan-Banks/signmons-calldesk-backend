# R02 working local tooling — 2026-09-15

Owner approved implementation and testing of private dummy-input and managed metadata restoration. Entry backend7c9521b/governance08b2951; focused origins fetched. Card APP013_P06_R02_TOOLING_CARD.md. Runtime application unchanged. No Neon connection, real credentials, data export or encrypted image changes. No scope deviation implemented.

## Implemented and tested

- scripts/p06_private_input.py: TTY-only input with echo disabled and restored; bounded input/deadline; exact scoped pgpass host/database/role; colon/backslash escaping; canonical0700/current-user parent; exclusive0600 no-follow file creation; cancellation/error removes only its newly created file. CLI accepts no arguments, pipe or environment password. Passwords never printed. Python memory clearing is best effort, not forensic zeroization.
- scripts/test_p06_private_input.py:4passing tests with multiple subcases, actual pseudo-terminal success/no-echo/permissions/escaping, Ctrl-C/EOF/empty/invalid/oversized/timeout cleanup, preserved existing files and symlinks, insecure-parent and nonterminal refusal. Dummy inputs only. PTY test subprocess leaves no bytecode artifact; generated test cache removed.
- Existing verify-p06-migration-upgrade.mjs now has P06_MANAGED_REHEARSAL=1, still local-only/private socket. Local NOLOGIN stand-ins reproduce neondb_owner/cloud_admin/neon_superuser object/default ACL roles without their provider administrative powers. Restricted p06_backup_reader cannot UPDATE or CREATE; pg_dump uses its read rights and a shared exported snapshot.
- Prepared empty local target with matching database owner and precreated cloud_admin-owned plpgsql. Restore preserves extension owner/default privileges/schema ACLs and table owners/ACLs. Compared all26fictional tables (23public +3legacy), including nonempty legacy fixtures, against same snapshot. No owner/ACL stripping.
- Missing restore role refuses before creating tables; half-truncated archive rolls back. Existing old13-to26 migration, constrained runner/no-op, preservation/revision/nullability/FK/check/unique/immutability/catalog and lock-failure gates pass.

## Defect actually found, not a new feature

First full restricted dump FAILED with permission denied for schema legacy_2025. Migration20260828000000 retains Tenant,Job,CallLog and three enums there. Prior proposed public-only SELECT list was insufficient; prior live inspection only enumerated public. Failure evidence /private/tmp/signmons-p06-upgrade-pqTGn0/report.json. Cleanup succeeded.

Corrected only the local fixture to include legacy read privileges, ownership and nonempty fictional rows; did NOT expand live grants or omit legacy from backup. Live legacy ownership/ACL/data size must be verified before amending the execution allowlist. The previous assertion that23public tables constituted the full database inventory is withdrawn. This is a missed prerequisite/defect within existing R02 full-backup scope, not a new task.

## Actual successful run

PG18.6 fresh private cluster /private/tmp/signmons-pg18-v1n56p/data, UTF8/C.UTF-8, no TCP,0700socket. P06_BACKUP_REHEARSAL=1 P06_MANAGED_REHEARSAL=1 P06_ROLE_REHEARSAL=1 with P06_PG18_SOCKET=/private/tmp/signmons-pg18-v1n56p/socket.

Report /private/tmp/signmons-p06-upgrade-PDvRVj/report.json: passed=true. Full custom archive119801bytes; SHA256869349fe5ad1af7730bdc3e72fbb5e5537cc40b69bc5cf929971d0df333fa07b. Six generated databases and six created roles removed; fresh database/role counts0/0. Server stopped. Cluster/archive retain fictional data only. An auxiliary SHOW lc_collate read failed because it is not a configuration parameter; initdb output establishes C.UTF-8, and explicit separate pg_ctl stop succeeded. No live action or rollback involved.

## Exact remaining limitations

1. Live inventory lacks non-public application schemas. Verify legacy and any other non-system schemas, then review amended least-privilege dump/restore manifest; don't execute the public-only proposal.
2. Live new-role password flow and ownership-enabled encrypted mount have not been exercised together. The helper implements private input, not mount/encryption validation; it must be invoked only after those independent gates.
3. This is local proof, not a real-backup executor. It has per-child120s termination and input deadline; production packet20minute aggregate,64MiB archive/768MiB workspace enforcement and sanitized streaming full-data comparisons are NOT implemented by this synthetic harness. Its assertion failures can print fictional row values, so NEVER use it on real data or an external socket.
4. Modeled metadata matches recorded public state plus repository legacy fixture; it does not prove cross-OS collation equality, uninspected live legacy metadata or complete Neon platform parity.

## Checks and progress

Private-input tests4pass (including SIGTERM cleanup); managed DB rehearsal pass after recorded defect correction; Python AST, Node syntax/Prettier, lint/build/architecture pass. Governance full consistency/frozen baseline/21regressions and whitespace passed. No app unit-suite rerun or browser feature acceptance claimed.

R02 has working local proof, not live acceptance. R01 closed; R02-R12 open11; added0. Accepted5/60 packages,3/8 walkthrough unchanged; ETA unvalidated. Next observable result: exact non-public source metadata and corrected real-action manifest, not another synthetic demo or new package.
