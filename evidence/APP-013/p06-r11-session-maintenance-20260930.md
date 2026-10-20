# APP-013 / 2B / P06-R11 exact-session maintenance — local implementation

Owner approved alternativeB local-only implementation in APP013_P06_R11_THREE_SESSION_CLEANUP_PROPOSAL_20260930.md. Source baseline3cf8a9d plus prior preserved working-tree changes; this change is uncommitted. No live data access/write, deployment, provider request, permission change, secret access or hold release.

## Implemented behavior

VerificationCleanupService accepts a distinct, deeply copied/frozen maintenance binding with exact tenant/account/operation/approval identities, finite validity, three unique expired conversation/session pairs and two exact OBSERVED operation snapshots each. Malformed/extra/duplicate scope refuses. Maintenance rejects customer end/sweep/reference-purge entry points; existing customer/fixture modes reject maintenance. There is no route/scheduler/registration.

All targets can be inspected without writes first. Each target's close and purge rechecks protected session identity/version, expiry, validity window and the entire six-operation account inventory under the existing session lock. State/amount/attempt/time/alias-count drift refuses. Existing close-before-purge transactions, idempotency, audit atomicity and conversation-wide submitted-review/job protections remain. Lifecycle closure does not rewrite Conversation.status. Verification fields and eligible matching version1/2 abandoned turns are removed by the existing purge; submitted/linked business payload, unrelated versions/sessions and business/audit/liability records remain. Maintenance audits add its operation/approval identity.

scripts/p06-cleanup-maintenance.mjs is an inert operational module with no CLI/default live target/credential/authorization. A separately reviewed private entry must supply a pinned plan hash and connector. It verifies source hashes/approval/window, reserves an exclusive consumed attempt, reuses READY-first readPipe, validates fixed-target/closed-runtime preflight, inspects all targets, then journals each ordinal before cleanup. Pending purge, uncertain write, private-input timeout or failed postchecks stops without retry; it closes the connection and saves only fixed status/counts. Exact-target connector/postflight implementation and installed live packet are not present or implied by synthetic connector tests. They require privately bound live target evidence and separate execution approval.

## Fresh validation

- Full Jest:132 suites passed, one existing suite skipped;2426tests passed,3existing skipped. /private/tmp/r11-maintenance-unit.log.
- Maintenance service focused suite15tests passed; inert runner13tests passed, including source/plan/approval/window rejection, consumed attempt, active runtime, pending purge, ambiguous write, private input timeout, final fingerprint and connection-close failure. Runner test fixtures use only synthetic connectors.
- Lint/build/architecture passed; logs /private/tmp/r11-maintenance-{lint,build}.log. Script syntax and whitespace checks passed.
- Complete existing disposable PostgreSQL/browser harness passed: /private/tmp/r11-capacity-evidence-41e0fbf2b2e4. New real database maintenance cases cover close-audit rollback, purge-audit rollback with closure preserved, concurrent duplicate cleanup/audit once, submitted-review and linked-job payload retention, abandoned session/version scope, and byte-equivalent saved operation/alias/audit/job records. Existing10loaded browser cases and other harness regressions also passed. Synthetic providers only. Harness exit0, remaining fixture databases0, owned cluster stopped/removed.
- Initial runner fixture used a macOS symlinked temp path and was correctly refused; fixed fixture canonical path and missing test import, without weakening source-path guards. Lint caught readonly-array narrowing and mock typing; corrected. Initial DB fixture lacked required actorId; corrected before successful rerun, failed run also cleaned up (/private/tmp/r11-capacity-evidence-133e7a7f5485). No assertion/guard weakened.
- Final governance frozen/consistency/baseline and all21safeguard checks passed, with whitespace checks in both repositories. Prior runtime evidence is not substituted for these fresh results.

## Scope and remaining gate

Local implementation checklist complete: approved contract, restricted service entry, inert runner, unit/runner/realDB regression and evidence. Local tests are not live cleanup or owner acceptance. Exact private UUID/expiry/business-retention metadata capture remains unapproved; snapshot ordinals are not executable identities. After a separately authorized read binds those identities, finish/test the concrete private connector and postflight against the existing seams and present one attended deletion packet for explicit live-write approval. Do not invent IDs, forge tokens or enable fixture sweeps/runtime. All three live sessions remain as last observed; capacity still exhausted in the saved snapshot.

P06 remains12/14,R11/fullR12open;accepted1A/1B/2A remain3/8. The owner-approvedB maintenance entry is implemented locally; no additional scope deviation.

## Changed-file hashes

- src/communications/verification-cleanup.service.ts: c1ba73dbf8391593b45aa5fc30c66b0f1564d1e2e9f8bed95254e14dd33ac321
- src/communications/verification-cleanup.service.spec.ts: c2aa56255257dc79aa37a689cd872c5c220d33f81e4ac2017eb675ac7f5e9e72
- scripts/verify-verification-cleanup.mjs: 5aef703ad263700f70ef95eb9deb23465846e9de4bb618a3e21269ec58b13371
- scripts/p06-cleanup-maintenance.mjs: 383ea2f662569f4c90b0ada5a7bdca3fc81d2d855c8c61a937e25ad31f0f04c6
- scripts/p06-cleanup-maintenance.test.mjs: 7a7dc87031b59084e366ab63bdb494e8b79a0493ac076594063a96efd68c4543
