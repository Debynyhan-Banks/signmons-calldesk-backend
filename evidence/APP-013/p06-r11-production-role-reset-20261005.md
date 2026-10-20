# P06-R11 production role password reset authorization

The owner authorized one Neon Console password reset for production branch `br-young-term-ayfi7ist`, compute `ep-nameless-frog-ayk5gr5y`, database `neondb`, role `neondb_owner`.

- Plan: `71088eb4-a6c8-444f-84e1-eb84b750eb3e`
- Operation: `570c2856-64d1-40ab-a4af-8a7c0ebe6c91`
- Owner-operated action: **Connect -> Reset password** once
- Private output: generated password saved directly in Apple Passwords
- Stop conditions: any target mismatch, refusal, lost output, or uncertainty
- Exclusions: every other branch/role, SQL reset, secret/version change, deployment, traffic, job, database-row, customer, messaging, booking, and payment action

The reset does not authorize or substitute for a later read-only authentication result. No scope deviation; accepted baseline remains 3/8.

The owner returned `PRODUCTION_ROLE_RESET_SAVED`, confirming completion and private capture. The reset authorization is consumed and does not authorize another reset.
