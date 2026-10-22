# R1-W01 / APP-013 / 3A / P07 approved local guards completed

October 22, 2026. Implemented and locally tested only; no live runtime/payment action or acceptance.

## Authority, source and exact package

Owner explicitly approved Alternative 1 for local correction/testing only in `APP013_P07_RUNTIME_GUARD_COMPLETION_PROPOSAL_20261022.md`, proposal `08660742253351c2f2ebe15c5292e2c9ab1cf29d`; decision recorded before coding at governance `d88dc4e8bd138046b8ca5dca36029a266c8b27d5`. Backend source `2c3ad5dbdbc599a8121539ed37e8d31e53542c5b`. Existing 3A card, exact acceptance, tenant/job, grants, resources, repaired image and costs unchanged.

Fresh private package `/private/tmp/p07-repaired-runtime-readiness-20261022-guards1`: plan `f3252875-1a8a-4c64-b642-254fdc30a620`; packet `6c91b550-78cf-4dd1-a93e-63d9a282e21e`; operation `abff0262-3504-4f92-b49d-5c5dea238cdb`.

Preparation manifest `e5868fa5d5673b07f6fba11a5cfb9f090c8efab2a862735c42ddf7216be0f407`; bound manifest `8320b0e5cc3f1600f763cbffe4621e6af95b277e88c9ba2461fd560436cf8860`; binding `8b1bd73d9f707c237f582735a0499183fc08073346f98d4d42abbe71242c7cd5`; controller `69f7a69a0b770457a6685e5ab0e69e4121832290d3f65e4dfbf4f624d4e72989`; tests `ba3098797eb85c3470121bd40356935463ee685c89bbaf85902b876bfea8d2b1`.

The attached patches expose all controller/test changes relative to unchanged repair5; manifest and binding are sanitized source metadata. Original package manifest `17c5fad2837ec01bb590d1607f4dbdaf88ab48ee3f8856fadf27f61279ced6fe` and all original source hashes still match. No existing helper, role SQL, application source, Prisma, Dockerfile, image or package dependency changed.

## Completed finite checklist

1. Work-deadline phase checks after input/waits/preflight and before each ordinary stage; per-command timeout capped by remaining phase; hidden input bounded by a restored alarm/terminal state. Cleanup uses its separate containment or retirement budget. Late completion cannot emit runtime-ready success.
2. SIGINT/SIGTERM enter existing cleanup; repeated catchable signals during cleanup cannot interrupt it, and deadlines remain enforced. Handlers/timers restored. SIGKILL/power loss remains outside catchable cleanup and uses existing journal-based recovery.
3. Tag removal requires absent readback; service identity requires exact matching disabled readback; final traffic read rejects extra nonzero routes/malformed results/tag residual. Failed or unavailable proof yields unconfirmed containment. Failed stop/cleanup receipt persistence cannot print verified success.
4. All 36 original test cases retained, with cleanup fixture strengthened to supply required identity readback. The preparation-state test now verifies a binding is either absent with the correct refusal, or valid with exact identity; it still refuses any owner approval/attempt/mutation journal before execution. Added 24 guard tests, including real child-process/PTY SIGINT/SIGTERM, repeated signals, hidden-input timeout/terminal restoration, real slow local subprocess termination, concurrent reservation, deadline crossing, positive flow/recovery, false acknowledgments and failed readback/persistence.
5. Source approval pinned to immutable pre-implementation decision/hash. Fresh IDs, private modes, complete inventory, syntax/hashes and disabled/refusal checks verified.

## Validation

- **60/60 focused tests pass before and after binding.** Printed READY/STOP/CONTAINMENT lines within this test run are synthetic assertions, not a provider outcome.
- Python AST and all three unchanged Node helper syntax checks pass.
- No-action check: `P07_PREPARATION_CHECK_PASSED_NO_ACTION`.
- Before binding, run/recover/retire each refuse `P07_REFUSED_WINDOW_NOT_BOUND` before hidden input/access. After binding, each refuses `P07_REFUSED_OWNER_APPROVAL_INVALID`. No attempt/result/stop/mutation journal or owner-approval receipt exists.
- Directory mode 0700 and all ten package files (including manifest) mode 0600; exact inventory/hash checks pass.
- Frozen-baseline/cross-repository consistency, 25/25 governance regressions, backend governance/architecture and whitespace gates pass. No app build/lint/full runtime test is claimed because application source/image is unchanged.

Initial local tests correctly rejected the old cleanup-success mock until it supplied the new disabled-state readback. Initial signal fixtures interrupted before obtaining a synthetic password and correctly got unconfirmed closeout; fixtures were corrected to interrupt the second hidden prompt after providing the synthetic password, preserving the separate pre-credential unconfirmed test. No live failure or receipt was rewritten.

## Window and next external gate

Owner supplied today **5:30–7:00 p.m. Eastern**. Bound local preparation: start 5:30, strict cutoff **5:45**, ordinary work ends **6:30**, containment by **6:50**, window ends **7:00**; retirement no later than **5:30 p.m. Eastern October 23**. Binding/retest creates no external authority. Exact live proposal: governance `APP013_P07_RUNTIME_READINESS_GUARDS1_OPERATION_20261022.md`.

Remaining/owner: Debynyhan Banks approves/refuses that exact operation before cutoff; implementer performs only its qualified browser/provider duties after approval, owner operates private Terminal input. Next observable result is `P07_REPAIRED_RUNTIME_READY_DISABLED` with closed role/zero sessions, disabled destination and preserved normal traffic, or fixed stop with mandatory truthful containment. P08 Checkout/payment and 3A acceptance remain separate.

Tenant binding remains live-demonstrated and contained. Accepted 1A/1B/2A/2B remain; **0/27 newly closed R1; 6/60 legacy; 4/8 walkthrough; 0/13 intelligence**. No database/provider/deployment/secret/IAM/payment action, credential input, merge or push occurred during local correction. **No scope deviation from the owner-approved three-guard correction.**
