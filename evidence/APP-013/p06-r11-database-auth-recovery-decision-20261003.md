# P06-R11 database-auth recovery evidence

Governance decision: `APP013_P06_R11_DATABASE_AUTH_RECOVERY_DECISION_20261003.md`

The 2026-10-03 credential-containment attempt created zero-traffic revision `signmons-calldesk-staging-app013dbrot1`, but database readiness stopped with PostgreSQL `28P01`. The owner-operated direct check also refused the only saved production password. The serving staging revision returns readiness 503; traffic remains on `app013bounds`; P06 remains disabled.

Prepared recovery artifacts:

- `scripts/p06-r11-db-auth-recovery.py`
- `scripts/test_p06_r11_db_auth_recovery.py`
- approved private package `/private/tmp/r11-db-auth-recovery-20261003-1725`

The fresh coordinator verifies a newly reset production password with `SELECT 1` before adding a secret version, deploys a distinct zero-traffic revision, requires readiness 200 before job update or traffic movement, preserves `p06-intake-disabled`, and uses immutable one-use stage markers.

The approved 5:00-6:15 p.m. operation passed preflight but stopped before adding a secret version because the privately entered Notepad value did not authenticate. The owner approved a fresh 5:25-6:40 p.m. direct-copy package. It requires a new production reset and direct use of Neon's Copy control. No external stage has executed under the fresh operation. No scope deviation.
