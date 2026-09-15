# P06-R02 — isolated credential and recovery qualification

## Scope and source

This is the remaining read-only qualification inside the approved P06-R02 task. It continues backend `45f4f47765b9c60c96a6b8d01fd79a7865af00f3` and governance `039d96d50d8d64cafdcad85d42d42aa9e93e3aa1`. The acceptance criterion is to identify the exact migration connection boundary and a usable recovery point, expiry, owner and method before R03 can request migration approval. It does not authorize credentials, connection, migration, restore, snapshot, deletion, deployment or application configuration.

## Current readback

Read-only Neon console inspection at 2026-09-15 05:05 EDT reconfirmed project `soft-smoke-54063480`, child `p06-isolated-staging-v1` / `br-sparkling-sun-ay6gr5e8`, endpoint `ep-jolly-flower-ayc6w9hv`, Free plan and fixed 0.25 CU idle compute. No record contents or secret values were opened.

- The child Roles page lists exactly one Postgres role: inherited `neondb_owner`, owning `neondb`, created and last updated 18 days earlier. Available role actions are Reset password and Delete role; Add role is available. None was selected.
- Neon documents that a normal child copies parent databases and roles and, unless the parent is protected, uses the same passwords. The project is Free; protected branches are a paid-plan feature. The current child therefore has endpoint separation but not an independently established database credential.
- The separate branch Credentials page contains no credentials and offers Create credential for Neon storage/AI integrations. It is not evidence of a Postgres migration credential.
- Backup & Restore shows a six-hour history window, an earliest currently selectable point of Sep 14, 2026 11:02 pm EDT, and `production` as the source for restoring `p06-isolated-staging-v1`. Preview data and Restore were not selected.
- The same page states that snapshots can only be created for root branches. Neon documentation agrees. The Free plan provides six-hour time travel/restores and one manual root snapshot; snapshot storage pricing is listed separately. No snapshot or restore was attempted.

Official sources reviewed: [protected branches](https://neon.com/docs/guides/protected-branches), [Postgres compatibility and role behavior](https://neon.com/docs/reference/compatibility), [database versioning with snapshots](https://neon.com/docs/ai/ai-database-versioning) and [current pricing](https://neon.com/pricing). These establish product behavior, not Signmons authorization.

## Result and blockers

R02 cannot close. A migration connection that does not reuse the parent credential is absent. A recoverable pre-migration state can be addressed only inside the moving six-hour history window unless a separately authorized root snapshot or recreate strategy is selected; the child itself cannot supply a durable snapshot. Restore, delete/recreate and snapshot operations are material external actions and are not authorized by this read-only section.

Before R03, the owner/database authority must approve both:

1. An exact child-only migration-role design and one credential creation. Recommendation: a SQL-created role on the child, without automatic `neon_superuser` membership, with only the ownership/membership and schema/database privileges proven necessary for the existing 13-file Prisma migration. Do not reset `neondb_owner`, expose a password in logs, or change the parent/shared `DATABASE_URL`. The exact SQL, secret destination, expiry/revocation and test connection remain to be reviewed before execution.
2. One recovery policy: either an explicitly time-bounded point-in-time restore of the child to a recorded pre-attempt timestamp while the six-hour window is current, or a separately costed root-snapshot/recreated-target procedure. The approval must name Debynyhan as restore authority, Codex as executor, the exact target, stop conditions and whether a destructive restore may be invoked after a failed attempt. No automatic restore or retry.

This section did not choose or execute either option. R01 remains closed; R02-R12 remain open (11). Accepted packages remain 5/60 (8.3%); walkthrough acceptance remains 3/8 (37.5%); P06 is unaccepted and ETA remains unvalidated. No scope deviation.

## Validation and review

Documentation/architecture/governance/whitespace checks apply. No runtime, schema, UI or packaged asset changed, so application tests and browser-product acceptance are not claimed. Review the child Roles and Backup & Restore pages without opening passwords or selecting Preview/Restore; compare this result with `APP013_P06_ISOLATED_BRANCH_PROPOSAL.md` and the fixed R02 row in `APP013_P06_REMAINING_TASK_BASELINE.md`.
