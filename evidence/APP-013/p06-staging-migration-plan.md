# P06 item 3 — staging migration plan review

Owner requested planning after the read-only schema gap. Reviewed all13 pending SQL files at source53037fb (unchanged at cab1df4), plus existing disposable database harness. No database/secret/provider operation this turn. No migration/runtime code edits, rebuild or deployment.

Authoritative proposal: governance APP013_P06_STAGING_MIGRATION_PLAN.md. Exact order/dependencies recorded for the13 already-existing migrations. Most create new storage/indexes/checks/triggers; important existing-table effects are SmsConsentRecord revision default1/increment trigger and PropertyAddress nullable location fields. Email intent constraints are replaced, so the set is not described as entirely additive. No top-level business-row DML or table/column drop, but that is not a zero-risk claim.

Plan requires synthetic old-state upgrade rehearsal (existing fresh-db tests are not a substitute), target/consumer isolation, verified recovery point/restore owner, bounded migration runner, catalog validation and explicit staging-only execution approval. No assumption of all-files transaction atomicity or automatic rollback; no migrate dev/reset/db push/history bypass. Exact runner settings must be exercised before use. No backup/clone/provider resource or migration authorized by planning.

Next: prepare/run the local synthetic upgrade rehearsal within this same release-readiness work, then finish recovery/target qualification. Execution stays blocked until qualified and explicitly approved. The two fixed remaining P06 items remain release readiness/review and capped staging acceptance; no added sections. Accepted5/60 (8.3%), walkthrough3/8 (37.5%), provisional4–8 weeks plus external waits unchanged, low confidence.

Validation for docs-only change: architecture, backend governance check, governance frozen/full consistency,21 regression tests and whitespace checks. No new runtime/rehearsal result claimed. No scope deviation.
