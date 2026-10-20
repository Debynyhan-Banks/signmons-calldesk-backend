# APP-013 / 3A / P07 — repaired build preparation review

Status: **disabled review packet prepared; existing controller guard gaps identified; local correction proposed before implementation**. Owner said “begin” after the preceding handoff named exact build/runtime proposal preparation as next. That authorizes this preparation, not a new Cloud operation or the material controller correction described below. Entry heads: backend `1c60cdab8b3cd66c7c78304875a8927f7eddbedd`; governance `a149ec2a2715e69732bcad3c8362244b53a86366`.

Approved section remains R1-W01 / APP-013/3A/P07. The unchanged customer acceptance is authentic same-job Sandbox settlement with failure/replay safeguards and verified closeout. A repaired image would advance existing deployment readiness; neither this packet nor an image constitutes that customer outcome.

## Prepared review packet

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
