# R02 full-schema metadata correction — 2026-09-15

Owner authorized read-only legacy catalog verification and proposed permission correction. Entry backend58d574a/governancec78f6a5; focused remotes fetched, worktrees clean. No customer rows selected, credentials read, grants executed, export or migration performed.

## Verified target and results

Existing authenticated Chrome Neon SQL Editor: project soft-smoke-54063480, child br-sparkling-sun-ay6gr5e8 (p06-isolated-staging-v1), neondb. Console history labels the batch Sep15 7:22am. BEGIN READ ONLY, SET LOCAL statement_timeout='10s', seven catalog SELECTs, ROLLBACK; all10 statements succeeded.

- current_database neondb; current_user neondb_owner; pg_database_size11165696 bytes.
- Only user schemas: public owned by pg_database_owner, ACL {pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}; legacy_2025 owned by neondb_owner, null ACL.
- public:23 ordinary tables,112 indexes. legacy_2025:3 ordinary tables,8 indexes. All relation owners neondb_owner; null relation ACLs; RLS and forced RLS false. No sequences, materialized views or other relation kinds in these schemas.
- legacy_2025.CallLog32768 bytes; Job32768; Tenant24576 (pg_total_relation_size). Sizes are storage metadata, not row counts.
-37 enums:34public plus legacy_2025.CallDirection, CallOutcome, JobStatus. All neondb_owner; null type ACLs.
- No functions in user schemas.
- Two default ACLs only: cloud_admin/public tables {neon_superuser=a*r*w*d*D*x*t*m*/cloud_admin}; sequences {neon_superuser=r*w*U*/cloud_admin}.

Catalog projections: pg_namespace names/owners/ACLs; pg_class grouped by namespace/relkind with count, owner equality, null ACL and RLS booleans; non-public ordinary table/sequence/materialized-view name/owner/ACL/RLS/size; pg_type enums name/owner/ACL; pg_proc identity/owner/security-definer/ACL; pg_default_acl owner/schema/kind/ACL. Namespace filter excluded pg_% and information_schema. No application table contents or password-bearing catalogs were queried. Existing public detailed inventory/migration checksums remain in p06-r02-source-metadata.md; this batch did not repeat migration checksums, sessions or quota.

## Correction and bounds

Migration20260828000000_canonical_schema_reconciliation intentionally preserves the original Tenant/Job/CallLog and their three enums in legacy_2025. Do not exclude them to make a restricted dump succeed.

Governance APP013_P06_R02_EXECUTION_PROPOSAL.md now proposes USAGE on public and legacy_2025; SELECT on the previous23public tables plus exactly legacy_2025."Tenant", legacy_2025."Job", legacy_2025."CallLog". No broad schema CREATE, write, managed-role membership, ALTER OWNER or default-privilege grant added. This corrects a proposal only; fresh exact inventory/collision/approval checks are required at execution.

Local26fictional-table restore proof was already completed in p06-r02-tooling-result.md, not rerun or relabeled as real recovery. Remaining R02: aggregate20minute/64MiB archive/768MiB workspace enforcement and sanitized streaming source/restore comparison; qualified ownership-enabled encrypted storage/actual new-role handoff; separately approved one real backup/restore proof. No new P06 task; R01 closed, R02-R12 open11, accepted5/60 and walkthrough3/8 unchanged, ETA unvalidated.

## Validation and review

Documentation-only change. Full governance consistency and frozen-baseline checks passed; all21 governance tests passed. Backend architecture and governance-baseline checks and both diff whitespace checks passed. App tests/build are not rerun or claimed for this metadata/docs-only section. Existing Chrome tab returned to Computes without changing settings.

Review this inventory against the amended two-schema26-table SQL allowlist, confirm no executable real-data command was introduced, and confirm R02 remains open with the same frozen acceptance criterion.
