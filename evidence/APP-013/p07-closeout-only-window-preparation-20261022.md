# R1-W01 / APP-013 / 3A / P07 closeout-only exact window preparation

Date: October 22, 2026. Status: bound and locally tested; exact external approval absent.

The owner supplied a 2:35 p.m. Eastern start in response to a 15-minute-block request. Bound window: **2:35–2:50 p.m. Eastern**; strict start cutoff **2:40**; hidden-input/query deadline **2:48**. UTC: `18:35`, `18:50`, `18:40`, `18:48`, respectively. USD 0; no retry.

- Package: `/private/tmp/p07-closeout-only-20261022-prep1`.
- Plan: `76a8f82d-1d34-44e9-8a5f-0234c48b8052`.
- Packet: `6504f835-2c15-4268-bc5b-16c9ee8f6bb6`.
- Closeout operation: `0d2f9eca-c8e8-49b6-b3c5-182416164a90`.
- Consumed target operation: `bfc0bb5b-1564-4991-a446-3960caa67d49`.
- Unchanged manifest SHA-256: `bf50b94c8039827e530944c4fa7bad664c3d8279f6627a05687b833afcb7c117`.
- Unchanged helper SHA-256: `2c57be00422d776365adadbc30a3d955df921d80467ad16cee9afaf611cbfee9`.
- Binding SHA-256: `986c3d118ec37ee86c86ec56262e7c90703af6f0ce33bdc33ccefc91228a7146`.

Only `binding.json` was added to the private package; all reviewed helper/test/plan/README/manifest files remain unchanged. The plan remains external-action-disabled. Exact approval must match all bound identities, manifest hash, times, no-retry flag and the sole `exact_read_only_session_closeout` action.

Verification after binding:

- `python3 -B -m unittest -v test_helper.py`: **21/21 passed**.
- `python3 -B -m unittest -v test_postgres.py`: **2/2 passed** with local synthetic sessions only. The disposable Unix-socket cluster was stopped/removed.
- AST syntax checks from the unchanged helper checkpoint remain applicable; no Python file changed during binding.
- Exact seven-file inventory, mode-0700 directory, mode-0600 files and every manifest hash passed.
- `python3 -B helper.py --check`: `P07_CLOSEOUT_ONLY_PREPARATION_CHECK_PASSED_NO_ACTION`.
- `python3 -B helper.py --run`: `P07_CLOSEOUT_ONLY_REFUSED_OWNER_APPROVAL_INVALID` before hidden input or database access.

No owner-approval, attempt, live closeout result or external database action exists. Original immutable stop/containment evidence remains unchanged. Separate exact decision: governance `APP013_P07_CLOSEOUT_ONLY_OPERATION_PROPOSAL_20261022.md`. Success is live zero-session readback and a verified receipt; failure is a fixed sanitized reason/stage and truthful unconfirmed containment. Do not retry the main or closeout operation.

Governance baseline/consistency, safeguard regressions, backend architecture and both whitespace checks are recorded with this documentation checkpoint. Actual containment remains unconfirmed and account handoff remains unresolved. Measures stay **0/27 R1; 6/60 legacy; 4/8 walkthrough; 0/13 intelligence**. **No scope deviation.**
