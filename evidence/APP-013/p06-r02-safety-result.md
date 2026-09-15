# R02 bounded backup safety tooling — 2026-09-15

Owner proceeded after legacy inventory correction. Entry backend f35a66d / governance61b34fa; focused origins fetched and clean; saved checkout unrelated changes preserved. Pre-code card: governance APP013_P06_R02_SAFETY_CARD.md. Scope is local safety tooling within existing R02, not recovery acceptance or a new task.

## Implemented

- scripts/p06_backup_guards.mjs: shared monotonic maximum20minute budget, never restarted by each command; fixed error codes without driver causes/SQL/row payloads; subprocess stderr drained/discarded; exclusive no-follow0600 archive streamed through a pre-write64MiB ceiling; monitored768MiB workspace total; SIGINT/SIGTERM/manual/deadline/resource cancellation stops owned process group and pending query connections. No CLI, credential, cloud target or live activation.
- Source/restore comparator uses read-only REPEATABLE READ transactions and one-row cursors, canonical session formatting, deterministic id::text/C ordering, <=1MiB serialized row; larger rows refuse. Actual values stay in volatile comparison memory, no retained row digests or per-row output. Returns only table/row counts and matched flag. Failures require rollback/connection close; no retry.
- Existing synthetic migration rehearsal uses these helpers for the full snapshot dump/restore/comparison path, including public and legacy tables. Managed metadata assertions now refuse without dumping differing objects. Existing fictional fixture setup/migration exercises remain local only and are not a real-data executor.

## Actual validation

-13 node tests passed: exact archive ceiling and overflow, existing-file/symlink/private-path protection, growth and shared-deadline stops, cancellation and SIGTERM process-group termination, expected failed-restore handling, bounded equal/empty/duplicate rows, mismatch/missing/extra/oversized rows, snapshot/inventory refusal, query cancellation and fictional private-marker redaction. Server statement/lock/idle-transaction timeouts shrink with remaining budget; pipelined connections refused.
-4 actual private-input pseudo-terminal regression tests passed.
- Existing full PG18.6 managed backup/role/migration rehearsal passed. Fresh private no-TCP UTF8/C.UTF-8 cluster: /private/tmp/signmons-pg18-08CDjv. Source snapshot comparison matched26tables/20fictional rows. A concurrent fictional source update after dump was excluded by the retained snapshot. Actual SQL mismatch and >1MiB-row tests refused without values, then explicit rollback/cleanup.
- Preserved managed owner/extension/default-ACL/schema metadata; missing-role/truncated-archive refusal, old13-to-all26 migration, replay no-op, constraints/immutability and deliberate lock-timeout checks passed.
- Initial report: /private/tmp/signmons-p06-upgrade-VXBmaF/report.json. Fictional archive119798bytes, SHA25656275429e9e5ef4c9ee8b66f9ab5afa6bc960299f4d02032b3f9632e6d820a68. Final rerun after server-timeout hardening also passed: /private/tmp/signmons-p06-upgrade-HJJQ9y/report.json,119795bytes, SHA25608921ef7deb753053752559a7c7ca5690b7c9b7ee8565d9621bad168abd32d51.
- Each run removed its six generated databases and six created roles. Fresh final catalog checks returned0fixture databases and0fixture/stand-in roles; listen_addresses empty verified in initial closeout. pg_ctl stop succeeded after each run. Retained private tmp artifacts contain fictional data only.
- npm lint/build/architecture, touched-JS syntax/Prettier, full governance consistency/frozen baseline and21 governance tests passed. No UI/runtime behavior changed: browser QA not applicable, no customer walkthrough acceptance asserted. No full app Jest rerun claimed.

## Limits and next existing gate

Archive output has a pre-write byte ceiling. Workspace checking is a recursive scan followed by50ms poll delay: it detects excess and stops, not a filesystem quota or a guaranteed maximum overshoot. Event-loop/filesystem latency can delay detection. Count includes the local cluster and archive workspace. SIGKILL/host failure cannot execute cleanup; no claim of host-crash recovery automation.

Shared deadline qualification covers dump/restore/read comparisons; synthetic fixture creation and migration tests are outside it. A future approved real invocation must construct this same budget from the remaining approved absolute UTC window, never give each phase a fresh20minutes, include all real run storage roots, and bind mandatory server/access/image cleanup. This reusable code does not authorize pointing the fixture harness at Neon.

Next is the existing ownership-enabled encrypted mount/private new-role handoff qualification and filled execution packet (exact window/current target, quotas, credential expiry, retention and cleanup); owner-approved real backup/restore proof remains required. No new roles/passwords, Neon access, real export, encrypted image mutation, deployment, charges or migration occurred this turn.

R02 remains open; R01 closed; R02-R12 open11; added0. Accepted5/60 packages and3/8 walkthrough unchanged; ETA unvalidated. No scope deviation.

Review the helpers/tests, existing rehearsal diff and this result. Do not interpret local safety tests or a documentation approval as real backup/credential execution authority.
