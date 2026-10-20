# APP-013 / P06-R11 child read-only qualification decision — 2026-10-08

The owner confirmed current child `neondb_owner` password custody without providing the value. Governance `APP013_P06_R11_CHILD_READ_ONLY_QUALIFICATION_DECISION_20261008.md` now fixes the next read to child branch `br-sparkling-sun-ay6gr5e8`, direct endpoint `ep-jolly-flower-ayc6w9hv.c-5.us-east-2.aws.neon.tech`, and forbids the production parent/pooler/shared URL.

The proposed operation reuses the hidden-input/no-retry transport and `scripts/p06-r11-post-cutover-query.mjs`. It returns only fixed liability aggregates and child approval/role/session classifications from one repeatable-read read-only transaction, then rolls back/closes. It stops before all cloud/provider/release work.

No identity, package, window or external read was created. No credential, secret, role, database, provider or cloud state changed. Owner approval of the exact decision plus a future25-minuteEastern window is required next.

P06 remains 12/14; R11/full R12 remain open; accepted milestones remain 3/8. No scope deviation.
