# P06 / R08 private-input adaptation — local qualification

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
