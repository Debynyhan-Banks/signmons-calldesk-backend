# APP-013 / P06-R11 enabled38 read-only reconciliation decision — 2026-10-09

## Purpose and criterion

This is the smallest reviewable follow-up to the consumed enabled38 browser timeout. It serves APP-013/2B/P06-R11 by authoritatively confirming retained aggregate liability and closed child runtime after the observed initial verification START. It cannot accept R11, create a job or authorize another journey.

Expected comparison state from immutable preflight plus route evidence is 17 valid phone holds / 8,500,000 micros, nine address operations / 900,000 micros at both account and tenant scopes, zero invalid rows, both controlled approvals false, and `p06_intake_runtime` expired/NOLOGIN/connection limit zero/zero sessions. Any different value is reported as drift and stops; no value is repaired.

## Reused source and target

- Backend HEAD: `3cf8a9dc53d0282a35e6263a36d749c5b32f8e2e`, with unrelated reviewed dirty APP-013 work preserved.
- Reader: `scripts/p06-r11-post-cutover-query.mjs`, SHA-256 `8c2214a7acfe76c8add13c99b77324f74acd7150c6a2696a10249adaa7704da3`.
- Target guard source: `scripts/p06-backup-once.mjs`, SHA-256 `46a29de169dd32725b313bf57dcf870d990f30f497d42f535cef893583d0bf26`.
- Fixed child: project `soft-smoke-54063480`, branch `br-sparkling-sun-ay6gr5e8`, direct endpoint `ep-jolly-flower-ayc6w9hv.c-5.us-east-2.aws.neon.tech:5432`, database/role `neondb` / `neondb_owner`.
- Production parent, pooled endpoints, overrides and shared application URLs are forbidden.

## Finite operation

After exact owner approval and one future 25-minute Eastern window, prepare fresh plan/operation identities and a private one-use package. The owner enters the saved child password through hidden TTY input; it is never displayed, logged, persisted or placed in argv/environment.

The helper makes one direct-child connection, verifies database/role/PostgreSQL18 and server read-only mode, begins `REPEATABLE READ READ ONLY`, performs the existing six fixed aggregate/state reads, rolls back and closes, then writes one sanitized receipt. Output is limited to counts, micros, invalid counts and fixed runtime classifications. It never returns identifiers, customer/contact/address/code data, audit rows or payloads.

Any authentication, target, identity, query, shape, unexpected count, open runtime or uncertainty condition consumes the operation and stops. No automatic retry or replacement is allowed.

## Tests, exclusions and finish

Preparation will rerun the existing fourteen fictional reader tests, syntax/format, exact source and target hashes, fresh approval/window bindings, no-action check, governance baseline/consistency, governance tests, architecture and whitespace. No new application code is required.

Excluded: job/customer search, password reset, secret access, LOGIN/hold/ceiling change, database write, migration, Cloud/Twilio/provider read, message/code, build, IAM, deployment, traffic/tag, browser journey, payment, booking or appointment action.

Observable finish is one sanitized `EXPECTED_POST_TIMEOUT_STATE` receipt or one precise terminal drift/stop, followed by rollback and closed connection. The operation then stops for owner review. R11/full R12 remain open; P06 remains 12/14 and accepted milestones remain 3/8.

No scope deviation.

## Approved window and checked package

Owner selected Alternative 1 for October 9, 9:15–9:40 p.m. Eastern (October 10, 01:15–01:40 UTC). Fresh plan `ba967f99-f130-4a6d-aa98-153a5e8b310d` and operation `8f8536f7-684b-42ed-85cc-dcf851aaba19` are installed at `/private/tmp/r11-enabled38-reconciliation-20261009-2115`. The private 0700 root/0600 files, exact source/target/approval/window bindings, Node/Python syntax, fourteen reader tests, no-action guard and required governance/architecture/whitespace checks pass. `R11_ENABLED38_RECONCILIATION_CHECK_PASSED_NO_ACTION` confirms no attempt marker or database access. Exact package execution remains pending owner approval.

## Completed result

The owner approved the exact plan/operation and ran it once. Attempt reservation was saved at `2026-10-10T01:16:41.453Z`; the read-only result was saved at `2026-10-10T01:16:55.294Z`. Terminal status is `R11_ENABLED38_RECONCILIATION_EXPECTED_POST_TIMEOUT_STATE`. The aggregate receipt records 17 total/valid phone holds / 8,500,000 micros, zero invalid phone rows; nine address operations / 900,000 micros at both account and tenant, zero invalid address rows; both approvals false; runtime role NOLOGIN, connection limit zero, expired and zero sessions. `runtimeClosed:true`, `executionAuthorized:false`, `readOnly:true`, `automaticRetryAllowed:false`.

Plan/authorization/binding/attempt/result identities match. No stop file exists. The result confirms the route-based conclusion that enabled38 consumed the 17th hold and no address operation occurred. It does not establish provider delivery or create a job. The operation is consumed and must never be rerun. Receipt SHA-256: attempt `9909e537b12a8dcfb4f52b9909c4e60231ed865c3c67bb3dbb06638f75a3e10e`; result `b37b9f52555c278223436ace06a653fad8fc3a2394bdce1db6966419582c3e8c`.
