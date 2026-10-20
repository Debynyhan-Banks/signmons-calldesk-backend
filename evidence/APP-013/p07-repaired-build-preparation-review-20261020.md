# APP-013 / 3A / P07 — repaired build preparation review

Status: **owner-approved local controller correction implemented and verified; packet remains disabled**. Owner explicitly answered “Approve bounded local correction” after the six guard gaps and finite card were presented. The original preparation checkpoint below preceded that decision: “begin” authorized proposal preparation only, with entry heads backend `1c60cdab8b3cd66c7c78304875a8927f7eddbedd` and governance `a149ec2a2715e69732bcad3c8362244b53a86366`. No external operation is approved.

Approved section remains R1-W01 / APP-013/3A/P07. The unchanged customer acceptance is authentic same-job Sandbox settlement with failure/replay safeguards and verified closeout. A repaired image would advance existing deployment readiness; neither this packet nor an image constitutes that customer outcome.

## Original preparation checkpoint — preserved review bindings

Private directory: `/private/tmp/p07-repaired-build-review-20261020-z4_gul98`.

- Plan: `a04a6ccd-4465-4f55-b60a-60881b8a0f64`.
- Packet: `787dcdcc-ec16-4a6c-b555-6e4154042d59`.
- Proposed operation: `006c9b9e-8171-4595-9128-10fdedf3660f`.
- Plan status: `PENDING_LOCAL_GUARD_REPAIR_AND_OWNER_APPROVAL`; approval and window are null. USD 1 is a proposed allowance, not approved spending, a provider price or an enforced billing cap.
- Proposed candidate tag: `p07-atomic-893432c1de02` in the existing backend image path. Its actual availability is unverified until an authorized fresh preflight.
- The copied controller is unchanged, expressly review-only and known to have guard gaps. No execution command is supplied. Do not change its status to approved or treat its copied historical tests as new results.

| Binding | Value |
| --- | --- |
| Repaired app commit | `465e12cf7ecf4874ddbd13a34bee60d85fbb02bd` |
| Archive | 986,100 bytes; 576 files; SHA-256 `893432c1de02c8068237711908099d452dd8e18dde6603240007bc61db5ed456` |
| Manifest SHA-256 | `28f51e7c79dfe21d54c0a8302ec615e408fc91769a60afa217f1d48702aaadb5` |
| Unchanged build config SHA-256 | `7a0fb42b31a1ab26a419ed4f109f36464e881d0c6bfaa42d014366dcb48ba5c5` |
| Review controller SHA-256 | `d02e2ff31e43963d982e17047a5227f850256d0c592645ae0b693b2be18b8884` |
| Historical test copy SHA-256 | `cb2b540535483764a03574641eb0fcdf7f417bb578fa0a39232afe99d0ad96e5` |
| Disabled plan SHA-256 | `afe7e823222c0bbff750e8d2f0e6b4416fb0217867a1d48073910eceee5299b8` |
| Disabled validation SHA-256 | `b80f372ed2eb1cfbf6ace35342327a776b490aecd763630707ed04941df706ef` |

Source lineage and exact two-file overlay verification remain in [source preparation evidence](p07-atomic-repaired-source-preparation-20261020.md).

## Newly demonstrated controller prerequisite

Two independent source inspections reviewed `/private/tmp/p07-build-control-20261020-0715/controller.py`, its original eight tests and consumed plan. The historical operation remains consumed; successful historical cleanup does not prove these untested branches safe.

| Inspected gap | Required local correction, not yet implemented |
| --- | --- |
| Live CLI accepts `--now`; Controller uses the override for time checks | Permit synthetic time only in isolated checks/tests; live execution uses actual time |
| `CONSUMED` and result appear only at completion; no exclusive durable attempt reservation precedes provider access | Reserve exclusively before external access; any reserved attempt, including interruption/uncertainty, is not replayable |
| `except Exception` excludes KeyboardInterrupt; cleanup sits outside `finally`; no SIGTERM handling | Route ordinary termination into mandatory cleanup and truthful containment reporting |
| Static validation checks status and file hashes but not the exact owner approval/action/resource/grant/allowance/no-retry envelope | Bind and validate the whole approved action envelope and ordered window before external access |
| `subprocess.run` has no timeout and grants do not recheck the deadline before each mutation | Bound commands and refuse further ordinary mutations after the cutoff; cleanup must remain available |
| No applied grants defaults `cleanupAllAbsent` to true, including preflight refusal for a pre-existing grant | Distinguish no mutation/cleanup unnecessary from independently observed all-grants absence |

These are proposed safety corrections to the existing build controller, not a payment feature, new subsystem or acceptance section. They are a material additional preparation prerequisite and require the explicit local decision in governance `APP013_P07_REPAIRED_BUILD_PREPARATION_PROPOSAL_20261020.md` before implementation. No application or controller repair is made by this record.

## Current validation and preservation

The review copies match their hashes, the archive has 576 safe regular-file entries, and its included build config matches the external config. A no-action check was run with subprocess execution replaced by an unconditional failure. It returned `PREFLIGHT_STOP / operation is not APPROVED_UNUSED`; subprocess calls were zero. No result directory, consumed marker or runtime receipt was created. This proves the current disabled status refusal, not repaired concurrency or cleanup behavior.

All eight files in the consumed old control directory, including its consumed marker and cached bytecode, match the before/after hash snapshot. Old build/source/UI archives and receipts were not edited. No Cloud/API/browser/provider call, IAM change, deployment, secret/database action, image build or payment occurred. Original eight controller tests and prior 97 application/22 database checks were not rerun as part of this preparation review.

## Remaining, next decision and progress

Implementer owns the proposed local guard correction and isolated mocked tests if approved. Owner decides that local correction, then later separately approves a complete fresh build-only packet with exact controller/plan bindings and window. Runtime preparation remains blocked on a repaired image digest and explicit live role/credential isolation, destination/signing, numeric secret, cost and zero-traffic containment decisions. No old window or allowance is renewed; the selected 4:00–5:15 availability was never execution authority.

Next observable result after the local decision: corrected controller passes its existing eight cases plus the finite safety/concurrency/termination/recovery matrix, and a disabled, fully bound build-only packet is ready for separate external review. P08 and owner acceptance remain pending. Counts stay **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**.

**Scope deviation proposal before implementation:** the newly demonstrated controller safety prerequisite is unapproved; no deviation has been implemented. No frozen criteria, queue, section IDs or denominator change is proposed.

Final preparation checks: frozen baseline, cross-repository consistency, all 25 governance safeguard regressions, backend governance/architecture and both repository whitespace checks pass. These are current preparation/documentation checks; no old runtime results are relabeled as newly executed.

## Subsequent owner-approved local correction — implementation entry

Owner explicitly answered **“Approve bounded local correction”** to the six corrections and isolated tests in the linked governance card. Entry heads: backend `2bf3f5f91faac5538924a5f99e7a4e93279790c5`; governance `1328c2f8a5a928ad05634a1ca87bf7e17af458f3`. The earlier review status above is the preserved preparation checkpoint; this later decision supplies local implementation authority before code changes. The private `local-correction-approval.json` records local-only authority; it is not a Cloud/build receipt.

Implementation remains restricted to the existing fresh controller/test/plan/README/evidence seams. The original controller/package/source artifacts remain immutable. External approval and window stay null. Controller correction tests, source preservation and final disabled binding results were pending at that entry; their actual results are recorded below. No scope deviation from the expressly approved local correction; no provider/deployment/payment action is authorized.


## Approved correction completed — current result

The six bounded guards are implemented in the fresh private controller only. Existing command/provenance/grant seams remain; there is no application, schema, SDK, dependency, runtime-role, secret, UI or provider change. The corrected source has 659 lines and 40,092 bytes. Original consumed files, original test archive and repaired application archive/config/manifest remain unchanged.

- Provider-capable entry rejects synthetic clocks. Exact owner receipt, final plan bytes, identities, resource/action/grant/allowance/flag envelope, source/config/controller/test hashes and ordered UTC windows are required. No local correction receipt can substitute for external approval.
- A durable exclusive ATTEMPT precedes any provider command; concurrent losers and prior ATTEMPT/STOP/result/consumed markers cannot replay. Possible grants are tracked only after durable mutation intent and before the add command.
- SIGINT/SIGTERM and repeated signals enter one mandatory cleanup path, including normal and recovery handoffs. Command timeouts are at most 30 seconds; preflight/grant stages and cleanup use 180-second budgets. Polling is bounded to 1,300 seconds and ordinary end. Mutation clocks are checked before each grant/submission. Cleanup-only recovery uses the original approval/attempt/journal and stays inside the separately bound cleanup deadline; it cannot submit a build or extend authority.
- Each possibly applied exact grant is removed independently; all three readbacks are independent. NOT_REQUIRED, known present and UNCONFIRMED remain distinct from VERIFIED_ABSENT. Pre-existing/unrelated bindings are preserved. Receipt/journal failures never publish durable success before required markers or skip cleanup; post-mutation stops are reported as uncertain with containment separately recorded.
- Uploaded source still requires exact bucket/object generation/bytes/hash and build/registry image identity/digest agreement. The actual prior gcloud `.gz` object format is explicitly covered, alongside safe `.tgz`; accepting a suffix never substitutes for exact content verification.

**Current verification:** root independently ran `/opt/homebrew/bin/python3 -B -m unittest -v controller_tests.py` in the fresh root: **45/45 test methods PASS**, 1.470 seconds. The original eight cases remain. The expanded matrix covers exact envelope/receipt/path/hash/window refusals, two actual competing processes, ten actual child signal combinations including repeated signals, all command/stage deadlines, provenance, partial grants/input drift, persistence truth, independent cleanup failures and bounded cleanup-only recovery/lock/expiry/refusal. Unsafe permissions/symlinks/hardlinks and consumed markers refuse before provider calls. Provider transport is synthetic; the installed gcloud, Cloud, database, Stripe and browser were not called. Synthetic approval fixtures exist only inside disposable test scratch and do not approve this packet. Syntax compilation passes. Prior 97 app/22 database results are not newly rerun.

| Current artifact | SHA-256 |
| --- | --- |
| Corrected `controller.py` | `00859bcef49739b7a891fc7cd2e993a18833e29ab79eabe6ad40f29251ba0eb0` |
| `controller_tests.py` | `36f5db7a51d24822213b17107bb61578725211fbc272a8890c486c222e0ab49b` |
| Root `local-test-results.txt` | `c45d5a707b2a19d9f12664b4099e526fa88acaa3e47a0a03269ca384dc375aea` |
| Current disabled `plan.json` | `6d0efe7c3860f67edf786ac5a94860c9ceff1e48cac518d13748d3eac86970b4` |
| `local-correction-result.json` | `4ef3e514a86d5a5209bda2b9109e9dbc73542d0e1c2a1e2d01f5eb30e280369c` |

The current plan is **PENDING_OWNER_APPROVAL**, preparationOnly=true, allowance PROPOSED_NOT_APPROVED, ownerDecision/approval/window null. The no-action check with subprocess execution forbidden returns **PREPARATION_DISABLED / OWNER_APPROVAL_REQUIRED**, zero subprocess calls. No owner-approval.json, ATTEMPT, STOP, CONSUMED or results directory exists in this review root. All eight old control-package hashes match the original receipt. Original source/config/manifest/test hashes also match.

**Completed local checklist:** all six corrections and all eight finite implementation-card tasks; current syntax, 45-method matrix, preservation and disabled binding checks pass. Independent source review found no remaining blocker. No scope deviation from the explicitly approved local correction.

**Remaining/owner/next:** the prospective build-only proposal is prepared in governance `APP013_P07_REPAIRED_IMAGE_BUILD_PROPOSAL_20261020.md` for October 20, 6:00–6:45 p.m. Eastern, submission strictly before 6:15, cleanup through 7:00. Owner separately approves its exact plan/hash/action/allowance/window. The current packet is not executable authority and supplies no launch command. Build success, a repaired image digest, live runtime/credential/destination/secret readiness, P08 and owner-accepted 3A remain open. Progress stays **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. No acceptance credit is awarded for these tests or source changes.


## Conditional build proposal — no external approval

The current disabled plan remains hash `6d0efe7c3860f67edf786ac5a94860c9ceff1e48cac518d13748d3eac86970b4`, unchanged and without window/approval. Private `build-operation-proposal.json` (SHA-256 `984b9e71a2cc4e8b6a1fb530b47871cbaf089e6ec4090259d14239bf00fcd67d`) records only a proposed deterministic transformation after an actual separate build decision. It is marked PROPOSAL_ONLY_NO_AUTHORITY; no executable approved plan or external receipt was written.

Only after exact owner approval, the reviewed transformation would set status APPROVED_UNUSED, preparationOnly=false, allowanceStatus/ownerDecision APPROVED and window `{startUtc:2026-10-20T22:00:00Z,submitBeforeUtc:2026-10-20T22:15:00Z,endUtc:2026-10-20T22:45:00Z,cleanupEndUtc:2026-10-20T23:00:00Z}`. All other fields/hashes remain unchanged. Canonical UTF-8 JSON with sorted keys, indent=2 and a trailing newline has expected final SHA-256 `e8520021bc4f31abd3902623e82bb772b2799a354d39efa8acac64ace51d193c`. A separate receipt must then bind those exact bytes to the actual owner decision; local correction approval is insufficient. The prospective date/window is a proposal, not renewed earlier availability or automatic execution authority.

The build-only proposal retains the exact archive, USD 1 proposed allowance, three temporary memberships, one submission/no retry, source/digest proof and mandatory cleanup; no runtime/Stripe/payment/deployment authority is bundled. Retaining the local packet is the alternative. No paid action, actual approval binding, Cloud access or marker was created while preparing this record.

Final correction/proposal checkpoint: frozen baseline, cross-repository consistency, all 25 governance safeguards, backend governance/architecture and both repository whitespace checks pass. The 45-method controller run applies to the exact frozen controller/test hashes above; subsequent changes are evidence/proposal/status only. Local-only correction authority is fulfilled; exact external build approval is requested separately and remains pending at this checkpoint.
