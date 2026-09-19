# P06 / R10 first attempt and mandatory closeout

## Result — 2026-09-18

- Approved section: APP-013 / P06 / R10, with mandatory R12 closeout on success or failure. Owner approval was plan `b228f87a-ed6e-4253-a62a-b33128bb094a`: database LOGIN from 9:25–10:00 PM Eastern and one connected run from 9:30–9:45 PM Eastern, including the exact no-traffic deployment, capped phone/address/reviewed-submit journey and closeout.
- Acceptance result: R10 did not complete. The no-traffic enabled revision failed startup before deployment readback. No activation attempt or approval write occurred, so R11 did not start: no verification code, Address Validation request, customer session, reviewed submission or job was attempted.
- Closeout result: complete for this failed attempt. The enabled tag is absent, normal traffic remains 100% on `signmons-calldesk-staging-app013bounds`, no controlled approval was active, and `p06_intake_runtime` is `NOLOGIN`, connection limit 0, past expiry and zero sessions. R12 overall acceptance remains open because there is no successful R11 connected evidence for owner acceptance.
- Ledger: P06 remains 11/14 complete. R10, R11 and R12 remain open. No scope deviation was implemented.

## Sanitized execution evidence

- The attended login action completed at `2026-09-19T01:27:27.196Z`: fixed runtime role OID `163840`, LOGIN true, connection limit 10, expiry `2026-09-19T02:00:00.000Z`, sessions 0.
- The deployment reservation was written at `2026-09-19T01:31:11.965Z`. Cloud Run created revision `signmons-calldesk-staging-app013p06enabled` from the reviewed image with zero normal traffic. The process emitted only the sanitized startup error `Controlled intake startup unavailable`; Cloud Run recorded `HealthCheckContainerError`, and the guarded action stopped at `DEPLOY` at `2026-09-19T01:31:37.906Z`. No `deploy-result.json` exists.
- A later invocation at `2026-09-19T01:42:53.579Z` refused at `DEPLOY_WINDOW`; the existing reservation and no-retry rule remain authoritative.
- There is no activation attempt/result/readback. The closeout preflight at `2026-09-19T01:49:07.422Z` found `activeApprovalFound=false`; its first guarded pass stopped at `REMOVE_TAG`. Authorized recovery then established the tag absent and completed the database shutdown at `2026-09-19T01:53:31.432Z`. Private result: `status=CLOSED`, approvals `NOT_ACTIVE`, role login false, limit 0, sessions 0, normal traffic revision `app013bounds`.
- Read-only Cloud Run reconciliation at `2026-09-19T01:55:39Z` found latest Ready revision `signmons-calldesk-staging-app013p06disabled`, exactly one 100% traffic entry on `app013bounds`, and no enabled target tag or revision in traffic. The failed revision remains retained as retired evidence.

## Demonstrated blocker

The executed sequence exposed a circular prerequisite that the local synthetic proofs did not exercise:

1. The approved R10 sequence required a healthy no-traffic enabled deployment and exact revision readback before the activation transaction.
2. `prepareControlledIntakeStartup` calls `loadControlledIntakeRuntime` before listening.
3. `loadControlledIntakeRuntime` immediately runs the current-approval database check and refuses unless `controlledRuntimeApproval.enabled=true` with the exact runtime digest and current window.
4. Therefore the enabled revision cannot become healthy before the later activation step. The synthetic loader/browser tests arrange an active approval before startup, so they do not prove the approved deploy-before-activate order.

This is an R10 plan/runtime-interface defect, not a provider outage or participant failure. Do not retry the consumed packet or reuse its expired authorization. The smallest proposed correction is a new R10 packet with a fresh revision, digest, origin and window that transactionally activates/read-backs the exact approval immediately before the no-traffic deployment, and automatically revokes on any deployment/readback failure before closing database access. This reverses a material step in the approved sequence and therefore requires a reviewed change record and new explicit owner approval before implementation or execution. A code change that starts a closed endpoint before approval is the larger alternative and is not authorized.

## Preserved boundaries

- No normal traffic shift, payment, Stripe action, booking, scheduling, dispatch, confirmation send, secret/IAM change, bootstrap, provisioning or R09 repetition occurred.
- No phone, participant HMAC, secret payload or private database credential is included here.
- The private attempt/reservation/stop/result records are retained on the encrypted volume. Diagnostic records remain distinguished from user attempts.
- Original dirty APP-010 checkout remains preserved.
