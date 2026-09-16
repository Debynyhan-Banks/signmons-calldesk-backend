# P06 / R08 private-input adaptation — local qualification

## Live preflight after owner review — stopped before assignment

2026-09-16 approximately11:41UTC, owner reviewed and said proceed. Fetched both focused remotes; clean source859ec4c/governance05607b1. Read-only Neon Console queries against exact child br-sparkling-sun-ay6gr5e8/neondb found log_parameter_max_length=-1 (guard requires0), pg_stat_statements.track=top with track_utility=on (guard refuses active utility tracking). Both parameters have superuser context and has_parameter_privilege(current_user,parameter,'SET') returned false for neondb_owner. No SET/ALTER/GRANT/reset/password statement was executed. Existing reset dialog was cancelled, not submitted.

Fresh role metadata: p06_intake_runtime OID163840, NOLOGIN, NOINHERIT, no elevated flags, connection limit10, memberships0. Exact encrypted mount /Volumes/Signmons-P06 is absent; no mount/unlock requested while logging admission is blocked. No credential read, generated, entered or changed. No executable approval packet/window issued. Console read-only queries may wake the existing capped compute; no metered invoice amount asserted.

Local tests did not prove compatibility with these managed live settings. Live preflight should have preceded implementation of the assumption that these strict settings could be satisfied; this is a qualification gap, not a new product requirement. Do not silently relax SAFE_LOGGING, grant superuser/parameter authority, recreate the role, disable global telemetry or retry the failed Console/native methods. PostgreSQL18 logging and pg_stat_statements documentation and Neon's Manage roles were consulted; they do not establish provider-internal password redaction for this exact managed path. The proposed temporary-session change is not executable with verified current authority.

R08 remains blocked on an explicitly reviewed provider-compatible secret-handling method/risk decision. Existing runtime helper stays fail-closed. No scope deviation implemented, no additional task, no acceptance/ETA change. Smallest decision is whether to authorize a bounded credential-method/security-policy review using the actual Neon path, rather than another password attempt or implementation. This review must prove any proposed password redaction boundary or explicitly present residual exposure; it cannot self-approve weakening the guard.

Owner approved implementation/local testing, not running against Neon. Entry source backend c053a2c / governance4f49c6d; scoped card APP013_P06_INITIAL_PASSWORD_REVIEW.md. This closes the three local method-correction exits inside existing R08; it does not close R08 or add a task.

## Implemented

- Existing p06-private-role-password.mjs gains fixed --runtime-initial-password mode, only p06_intake_runtime on the reviewed child. Clean source SHA, exact26-migration checksums, role OID/NOLOGIN/NOINHERIT/no elevation/no memberships/connection limit10, catalog/grant/ownership fingerprint, no other sessions, strict existing logging guard, <=15-minute approval and <=5-minute metadata freshness are bound to a packet. No arbitrary target option.
- Existing encrypted-volume identity/exclusion/ownership checks and exclusive0700 directory/0600 files guard runtime-only persistence. Two exclusive attempt markers stop simultaneous wrappers/duplicate mutation. Generated32-byte random password is persisted before the sole fixed ALTER ROLE statement, inside verified TLS; administrator input remains hidden TTY to anonymous pipe. No password in command args, environment, ordinary history, receipts or user-visible errors. JavaScript memory zeroization is not claimed.
- Role/grant fingerprint is verified around commit; no LOGIN, expiration or grant changes. Any after-send failure is indeterminate; never retry automatically and never discard its recovery artifact. Bounded administrator cleanup precedes the safe result receipt. The image stays mounted for owner-private credential handoff; no automated secret upload or artifact deletion. Owner closes it after reviewed handoff; uncertain outcomes require reconciliation first.
- Existing migration/backup modes are preserved. Python recognizes only the exact runtime success protocol; driver diagnostics are suppressed.

## Validation

- P06_PRIVATE_LOCAL_PROOF=1 node --test scripts/p06-private-role-password.test.mjs:15/15 passed, including old migration and new runtime synthetic private PostgreSQL18 proofs. Synthetic fixture uses local-only socket/no TCP; proves actual password authentication, wrong-password refusal, NOLOGIN refusal and unchanged metadata. LOGIN is toggled only for that disposable fixture and restored before fixture removal. No Neon connection.
- python3 -B -m unittest scripts/test_p06_private_input.py:12/12 passed; hidden-input echo restoration, cancellation/timeout, anonymous pipe, protocol and canary redaction.
- Negative/uncertain tests: wrong identity/source/target/window/OID; absent/elevated/login role, memberships, changed grants/migrations/logging, active sessions, file collision/symlink, concurrent/duplicate execution, cancellation before send, send/commit/post-commit error. Artifact retained and safe status only. Existing certificate-refusal and logging tests remain passing.
- npm test -- --runInBand:129 suites passed,1 skipped;2359 tests passed,3 skipped. npm run build, npm run lint, npm run arch:check passed. Script formatting checked separately; application lint only covers src TypeScript.
- Browser QA not applicable: no app UI change. Private-input tests use synthetic pseudo-terminal; no real password or live terminal interaction claimed.
- Shared backup/guard regression:25/25 passed. Complete cross-repository consistency, frozen baseline,21 governance tests, script formatting and both whitespace checks passed. Disposable fixture roles/databases removed; owned local server stopped and its temporary authentication-config addition removed.

## Review and remaining gate

Review the four changed existing scripts/tests and the three-exit governance card. Reproduce the Node/Python commands; private PG proof requires the explicitly guarded disposable socket fixture, never a remote database. Review the refusal policy and encrypted-artifact retention before approving execution.

Fresh owner-approved packet must name exact source SHA, child target, role OID and reviewed fingerprints, operational allowance/window and logging risk. No ready-to-run packet is created by this change. Provider-internal logging absence is not proved by local PostgreSQL tests or pg_settings. If live settings fail the guard, stop with the exact failed condition; do not disable audit or silently lower protections. No password/reset retry, LOGIN, secret upload/IAM, provider call, deployment or tenant activation occurred this turn.

No scope deviation. Original12+approvedU01/U02=14; nine closed, R08-R12five remain. Packages5/60(8.3%), walkthrough3/8(37.5%), P06 unaccepted; these are not whole-app completion. ETA remains unvalidated and no acceptance credit is earned for helper tests. Next observable result is reviewed local patch followed by separately authorized fresh execution preflight, not another subsection.
