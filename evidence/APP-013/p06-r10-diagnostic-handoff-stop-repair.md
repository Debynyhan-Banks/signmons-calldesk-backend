# P06 / R10 diagnostic handoff stop and local repair

## Stopped operation — 2026-09-19

Owner-approved diagnostic plan `a76b6bb9-780c-4d94-984b-fae664758217` created its one-use reservation at `2026-09-19T19:00:31.795Z`, then the private wrapper reported `R10 diagnostic stopped or result unconfirmed. Do not rerun.` The operation is consumed and was not rerun.

Local inspection identified a deterministic transport defect before the database boundary: the new plan-specific Python wrapper wrote the hidden bytearray to the anonymous pipe and closed it without writing the newline required by `scripts/p06_backup_guards.mjs::readPipe`. That reader accepts only one printable line ending in `\n`; it therefore refused the handoff before `diagnoseFixedChildActivation` could be imported or called. No database connection or read occurred. No LOGIN change, activation, deployment, provider request, customer action or mutation occurred.

## Local repair

Backend adds `scripts/p06_private_diagnostic.py`, reusing the established `private_read` and `read_ready` functions from `scripts/p06_private_input.py`. The repaired transport writes the secret and the required newline separately, zeros its bytearray, accepts only one bounded sanitized diagnostic status, restores the terminal and redacts child failures. Its direct CLI is inert. `scripts/test_p06_private_diagnostic.py` drives a real Node `readPipe` through a pseudo-terminal and proves the newline-framed secret reaches the reader, the safe status returns, terminal echo is restored and secret/failure output is absent.

Validation:

- `python3 -m unittest scripts/test_p06_private_diagnostic.py -v` — 3 passed.
- `python3 -m unittest scripts/test_p06_private_input.py -v` — 12 passed.
- `node --test scripts/p06-r10-activation-diagnostic.test.mjs scripts/p06-runtime-packet.test.mjs scripts/p06-r10-controller.test.mjs` — 32 passed.
- `npm run arch:check` — passed.
- `git diff --check` — passed.

The consumed operation remains unusable. No new packet, authorization or live read exists. P06 remains 11/14 with R10/R11/R12 open. Next requires a fresh future attended window, a new one-use diagnostic operation bound to this tested transport and separate exact owner approval. Original dirty APP-010 checkout preserved. No scope deviation.
