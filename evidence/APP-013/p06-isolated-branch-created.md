# P06-R02 — authorized isolated branch creation

## Authority and result

Owner approved the standard current-data child, private inheritance, Free-plan constraints and no expiry, then separately answered yes to creation with the default compute followed immediately by a 0.25 CU cap. Exactly one Create submitted; successful result observed. No retries. Creation UI timestamp: 2026-09-14 22:03:09 (console display; timezone not independently exposed). Observed in America/New_York session.

- Project: soft-smoke-54063480, signmons-staging, Signmons Free, Ohio, PostgreSQL18.
- Parent: br-young-term-ayfi7ist, production; remains default and idle with 0.25–2 CU compute in final branch list.
- Child: p06-isolated-staging-v1, br-sparkling-sun-ay6gr5e8.
- Endpoint: ep-jolly-flower-ayc6w9hv; direct host ep-jolly-flower-ayc6w9hv.c-5.us-east-2.aws.neon.tech. Database neondb; inherited role neondb_owner. Password remained masked and was not copied or reset.
- Expiry Never, explicitly selected before Create. No snapshot or automatic cleanup created.
- Initial compute 0.25–2 CU; immediately edited and saved fixed0.25 CU, verified on Computes and final branch list. Editor reports scale to zero after five minutes of inactivity. Actual idle transition not yet observed; setting verified, not a timed suspension test.
- Final branch count2/10. Preflight usage1.84/100 CU-hours,0.04/0.5GB storage,0/5GB transfer; metrics delayed, not an invoice or proof of zero resource use. No upgrade/payment prompt accepted.
- Overview showed one database/one compute, BetterAuth not started, no enabled Functions/Object storage/AI Gateway shown. No application connected by this work.

## Boundaries and remaining risk

Normal child inherits data/roles/passwords. No record contents read/exported, credentials revealed, secrets changed, app connections configured, migrations run, Cloud Run actions, parent configuration edits or provider sends performed. Endpoint separation is not credential isolation; branch-only credential separation and exact migration connection must be qualified/approved before application use. Shared project quotas remain shared. Six-hour history is not durable backup proof; usable recovery checkpoint/expiry and restore ownership still require qualification. No restore or snapshot performed. Retained child storage requires reviewed closeout, not automatic deletion.

R02 remains partial; R01 closed, R02–R12 open:11 remain, added0. Accepted5/60 (8.3%), walkthrough3/8 (37.5%); P06 unaccepted and ETA unvalidated. This advances the approved isolated target for the same connected 2B journey, not a new feature. No scope deviation beyond approved branch/setup amendment.

## Review and checks

In existing Neon project, open Branches: confirm exactly production and p06-isolated-staging-v1; child parent production. Open child Overview to verify ID and expiry Never; Computes to verify ep-jolly-flower-ayc6w9hv and0.25CU; Edit (without saving) shows five-minute idle suspension. Do not show credentials, connect, migrate or delete during review.

Documentation-only repository changes. Frozen baseline and full consistency passed before action. Post-change governance/regression/architecture/whitespace results recorded in handoff; no new application test/build/lint claim. Provider-directory CLI unavailable; used existing signed-in Neon UI, no tools installed.
