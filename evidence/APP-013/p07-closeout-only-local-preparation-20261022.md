# R1-W01 / APP-013 / 3A / P07 closeout-only preparation

Date: October 22, 2026. Status: implemented and locally tested; no external execution or acceptance.

## Authority and customer-workflow connection

Debynyhan Banks approved Alternative 1 in `APP013_P07_MANDATORY_CLOSEOUT_RECOVERY_PROPOSAL_20261022.md` for local preparation/testing, specifically requesting failure reasons be logged. The complete pre-code card is `APP013_P07_CLOSEOUT_ONLY_SECTION_CARD_20261022.md`. Backend source `057465be235ab6117ea22cae3e4c35f27e6f6aba`; immutable governance decision/card `c147efa88de26ec391cbef959f6923ebb4b7728c`.

3A still requires authentic same-job Sandbox payment settlement. This helper addresses mandatory session closeout for consumed tenant-binding operation `bfc0bb5b-1564-4991-a446-3960caa67d49`, before that workflow can proceed. It earns no customer acceptance credit.

## Package and boundaries

Fresh package: `/private/tmp/p07-closeout-only-20261022-prep1`.

- Plan: `76a8f82d-1d34-44e9-8a5f-0234c48b8052`.
- Packet: `6504f835-2c15-4268-bc5b-16c9ee8f6bb6`.
- Closeout operation: `0d2f9eca-c8e8-49b6-b3c5-182416164a90`.
- Helper SHA-256: `2c57be00422d776365adadbc30a3d955df921d80467ad16cee9afaf611cbfee9`.
- Manifest SHA-256: `bf50b94c8039827e530944c4fa7bad664c3d8279f6627a05687b833afcb7c117`.
- Exactly six mode-0600 files in a mode-0700 directory: helper, two test files, README, plan, manifest.

There is no window, owner live approval, attempt or live closeout result. The one-use helper reads only the exact `pg_stat_activity` session count for the consumed operation prefix inside READ ONLY / ROLLBACK. It asks only for the current CHILD administrator password through hidden owner-operated Terminal input; an echo fallback refuses. It uses verify-full/system roots, explicit host/port/user/database, a whitelist of child environment values, query/connect/process deadlines and an input deadline. It kills/reaps a client on timeout/interruption; it never terminates database sessions or retries a query.

## Failure reporting

Every attempted read finishes with a private `closeout-result.json` containing an allowlisted reason, stage, operation IDs, timestamps and booleans. Terminal prints the same fixed reason/stage. Recognized codes include `AUTHENTICATION_FAILED`, `TLS_FAILED`, `DNS_FAILED`, `CONNECTION_FAILED`, `DATABASE_TIMEOUT`, `QUERY_PERMISSION_DENIED`, `SESSIONS_REMAIN`, `OUTPUT_INVALID`, `COMMAND_TIMEOUT`, `DEADLINE_EXCEEDED`, `INTERRUPTED` and `HIDDEN_INPUT_UNAVAILABLE`.

Unrecognized errors remain `DATABASE_ERROR_UNCLASSIFIED`; local failures remain fixed local codes. Classification is best-effort recognition of the current in-memory error, not guaranteed forensic diagnosis. Raw errors, SQL output, passwords and private identifiers are never persisted or printed. The previous failure cause remains unknown because its original helper discarded the error; this implementation does not reconstruct or overwrite that historical evidence.

## Verification

- `python3 -B -m unittest -v test_helper.py`: **21/21 passed**. Coverage includes success/failure reasons and stages, exact SQL and TLS/environment boundary, nonzero/malformed output, hidden-input/TTY and echo-fallback refusal, real input alarm, signal handling, child kill/reap, unknown/sensitive-error sanitization, concurrent exclusive reservation, replay refusal, private exclusive receipt/symlink refusal, manifest rejection and exact/no-window/no-approval validation.
- `python3 -B -m unittest -v test_postgres.py`: **2/2 passed** on PostgreSQL 16.11. The Unix-socket-only disposable cluster detects a named synthetic competing session, refuses it, returns zero after it naturally closes and proves an empty result separately. Cleanup stopped the server and removed the cluster through registered class cleanup. Escalation allowed only local shared memory; no live database was contacted.
- Standard-library AST syntax checks passed; exact six-file inventory, all private modes and manifest hashes passed.
- `python3 -B helper.py --check`: `P07_CLOSEOUT_ONLY_PREPARATION_CHECK_PASSED_NO_ACTION`.
- `python3 -B helper.py --run`: `P07_CLOSEOUT_ONLY_REFUSED_WINDOW_NOT_BOUND` before hidden input or database access. No-approval refusal is tested using synthetic local binding files only.
- Frozen baseline, cross-repository consistency, 25 governance regressions, backend architecture and both whitespace gates are required and recorded in this checkpoint's tool results.

Original interrupted stop SHA-256 remains `91787ebef4554e806a797aebf085c76aa68f39a325d692cb11eb33919126efca`; original `closeoutVerified:false`, `commitState:NOT_STARTED` and absent mutation intent remain intact.

## Remaining gate and progress

Owner supplies a fresh attended block for the read-only closeout; implementer binds/retests exact window and manifest, then presents the finished operation for separate approval. Until that read succeeds, actual containment remains unconfirmed. The account handoff failure remains a separate unresolved prerequisite; this helper does not solve or retry it.

Accepted measures remain **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones (1A/1B/2A/2B); 0/13 full-intelligence rows**. **No scope deviation from the approved local closeout recovery and failure reporting.**
