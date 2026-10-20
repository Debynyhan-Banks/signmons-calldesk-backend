# APP-013 / 3A / P07 — exact repaired-image build result

Status: **P07_IMAGE_BUILT; mandatory closeout independently verified**. The exact approved build completed once; the repaired image remains unused. This is infrastructure readiness evidence, not payment demonstration or 3A acceptance.

Owner explicitly answered “Approve one exact build” to Alternative 1 in governance `APP013_P07_REPAIRED_IMAGE_BUILD_PROPOSAL_20261020.md`, including its exact conditional plan transformation, October 20 6:00–6:45 p.m. Eastern window, submission strictly before 6:15, mandatory cleanup through 7:00, USD 1 allowance, three temporary memberships and no retry. No deployment/database/secrets/Stripe/payment action is included.

Execution-entry heads: backend `beb94a8b4048e5f42ea596a726145e9b28a344c6`; governance `a741e79648028538fa4f1476d29ab7c0a1114ea6`. Private root: `/private/tmp/p07-repaired-build-review-20261020-z4_gul98`.

| Binding | Identity / SHA-256 |
| --- | --- |
| Plan | `a04a6ccd-4465-4f55-b60a-60881b8a0f64`; `e8520021bc4f31abd3902623e82bb772b2799a354d39efa8acac64ace51d193c` |
| Packet | `787dcdcc-ec16-4a6c-b555-6e4154042d59` |
| Operation | `006c9b9e-8171-4595-9128-10fdedf3660f` |
| Actual approval receipt | `3e08516d957b69c165df676effad85d76fc3f32c94b9c2f90b5f1514110992ac`; recorded `2026-10-20T21:50:10Z` |
| Repaired app commit | `465e12cf7ecf4874ddbd13a34bee60d85fbb02bd` |
| Exact source | `893432c1de02c8068237711908099d452dd8e18dde6603240007bc61db5ed456`; 986,100 bytes; 576 regular files |
| Manifest | `28f51e7c79dfe21d54c0a8302ec615e408fc91769a60afa217f1d48702aaadb5` |
| Corrected controller | `00859bcef49739b7a891fc7cd2e993a18833e29ab79eabe6ad40f29251ba0eb0` |
| Tests | `36f5db7a51d24822213b17107bb61578725211fbc272a8890c486c222e0ab49b` |
| Build config | `7a0fb42b31a1ab26a419ed4f109f36464e881d0c6bfaa42d014366dcb48ba5c5` |

Independent local binding/preservation review passed before the approved opening. Actual-clock no-action check refused early execution; a synthetic-clock no-action check qualified only local bindings and made no provider call. The controller was invoked once after 6:00 with real time and no override. Fresh preflight passed. The exact three temporary memberships were applied/read back; one submission at `2026-10-20T22:00:29.352577Z` returned build `9ee7772a-62b1-4a07-86ad-0c3b9daf3032`. No retry is permitted.

The controller observed terminal SUCCESS at `2026-10-20T22:04:16.613430Z`, verified source/digest at `22:04:20.182211Z`, and recorded all three temporary permissions VERIFIED_ABSENT with errors[] at `22:04:26.168708Z`. Final result finished at `22:04:26.168857Z`, persistenceConfirmed=true and submissionAttempted=true. A separate live readback at `22:05:15.902895Z` independently confirmed build/project/image identity, exact uploaded source generation/bytes/hash, registry digest and all three memberships absent. It ran six read commands with zero mutations and failures[]. No retry or cleanup recovery was needed.

Accepted counts remain **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. **No scope deviation from the exact approved build.** No customer capability is accepted by this infrastructure operation.


## Immutable image and uploaded source

Build ID: `9ee7772a-62b1-4a07-86ad-0c3b9daf3032`. Image tag: `us-east5-docker.pkg.dev/signmons/signmons/signmons-calldesk-backend:p07-atomic-893432c1de02`. Build and registry agree on digest **`sha256:36f887749947c0b01db683482c081ca663534e7ffe597560b24597f3d46be9da`**. This repaired candidate supersedes the earlier unused buggy candidate for future review; neither image was deployed by this operation.

Uploaded object: `gs://signmons_cloudbuild/source/1792533626.326269-f765af6ec7ff4edcbd652fd3a06998f7.gz#1792533627176523`. Both controller download and independent source read match **986,100 bytes** and SHA-256 `893432c1de02c8068237711908099d452dd8e18dde6603240007bc61db5ed456`. No success is inferred from a tag or HTTP response alone.

## Closeout, preservation and evidence

The only temporary memberships were bucket storage.objectViewer, repository artifactregistry.writer and project logging.logWriter for the existing signmons-build identity. Each was removed; all three scopes were independently read back absent by the controller and again by separate live checks. No containment failure remains. No Cloud Run revision/tag/traffic, database/role/credential/secret, Stripe/event/payment, booking/customer/message, UI publication, production migration or repository publication action occurred.

The operation is consumed. ATTEMPT and CONSUMED are durable and the final plan/approval hashes remain unchanged; the literal APPROVED_UNUSED value in the immutable plan does not permit replay. No recovery, STOP or second submission exists. All eight original consumed-package hashes and the source/controller/test/config/manifest bindings remain unchanged, independently reviewed.

| Receipt | SHA-256 |
| --- | --- |
| `ATTEMPT` | `fecd223443c5a64cbda22a2acd4de865b98b1eedee9ba1eee2e098797348f749` |
| `CONSUMED` | `a03f3661955a927823d65b05147f86f45e8081f4ab219eb0e10114b744a0bf9d` |
| `results/result.json` | `eccd03c1bcb0fe68b286423ad56ab9bbc0ccf25af6caf5c76b35b4efbbf94355` |
| `results/journal.jsonl` | `5b690e028a2a76952d428694a3154be179f8472e78f40e4b47fabd017d9c18aa` |
| `results/independent-readback.json` | `91ef910ba0402db107b238389d4ac09928b0ad4432e48395292acffdfd0b67ea` |

Private receipts remain under the bound review root. Independent local review corroborated attempt/plan/packet/operation chronology, one submission and containment; the separate live readback is the external corroboration. The six provider read commands are actual commands, not a claim about the count of underlying HTTP requests. Actual invoice cost is unverified; the USD 1 approved operational allowance is not a provider-enforced cap. Existing retained holds/cost reconciliation remain unchanged.

## Remaining and next observable result

No work remains for this approved build/permission-closeout operation. Implementer next prepares a concrete proposal bound to this repaired image digest for live runtime/credential isolation, numeric database/signing-secret bindings/costs, exact accepted-job readiness, disabled Stripe destination and one zero-normal-traffic deployment with containment. Those actions remain unapproved and their architecture choices unresolved; no runtime command is ready. Owner approves applicable external actions and later accepts the authentic same-job Sandbox outcome. P08 and 3A remain open.

**No scope deviation from the exact approved build.** Accepted measures remain **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. Building an image does not close a customer acceptance package.

Final handoff validation: frozen baseline, cross-repository consistency, all 25 governance safeguards, backend governance/architecture and both repository whitespace checks pass. No application/runtime tests were rerun or represented as new for this build/evidence checkpoint. The earlier 45 local controller methods and 97 app/22 database checks remain separately recorded source prerequisites.
