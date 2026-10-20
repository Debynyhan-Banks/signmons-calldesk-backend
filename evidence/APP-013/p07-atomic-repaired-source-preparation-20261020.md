# APP-013 / 3A / P07 — repaired source review archive

Status: **local source preparation only**. The owner-approved atomicity repair is committed at `465e12cf7ecf4874ddbd13a34bee60d85fbb02bd`; its implementation and current test results are recorded in [the repair evidence](p07-webhook-atomicity-local-repair-20261020.md). This record adds no application change, cloud build, deployment, provider access, payment or operation authority. **No scope deviation from the approved local repair.**

## Exact artifact

Private directory: `/private/tmp/p07-backend-source-review-20261020-atomic-465e12c-9gmmrsyq`.

| File | Bytes / contents | SHA-256 |
| --- | --- | --- |
| `backend-source.tar.gz` | 986,100 bytes; 576 regular files | `893432c1de02c8068237711908099d452dd8e18dde6603240007bc61db5ed456` |
| `backend-source.reproducibility.tar.gz` | Byte-identical second archive | `893432c1de02c8068237711908099d452dd8e18dde6603240007bc61db5ed456` |
| `release-manifest.json` | Provenance, normalization, every file hash and preservation checks | `28f51e7c79dfe21d54c0a8302ec615e408fc91769a60afa217f1d48702aaadb5` |

## Provenance and verification

The archive reuses the verified original **filtered** P07 backend archive, rather than substituting an unfiltered git archive. The original has 576 files, 984,980 bytes and SHA-256 `6b499c4431a2e10d2fd032d167232bfb710209b9d6fa5056df1de236cc5b8400`. Exactly two files are replaced with blobs read from the committed repair:

| Path | Repaired SHA-256 |
| --- | --- |
| `src/payments/stripe-webhooks.service.ts` | `fb35798fa5940e9c047c5d5e840c535efd1db64e393788c02b1f5ab7389216d0` |
| `src/payments/stripe-webhooks.service.spec.ts` | `1afacb5927254aa981e9255ccf9f220b482448fbd4ba9506a41e0ad02f76ddc3` |

Archive readback verifies the unchanged complete path set, all 576 manifest hashes, the exact two-file difference and matching committed blobs. Paths are relative and safe; entries are regular files without links. Ordering and tar/gzip metadata are normalized; original file modes are preserved. A second archive is byte-identical. The local role verifier and SQL role fixture are excluded, as in the original filtered source.

The original backend archive, original manifest and both UI archives remain unchanged. Original manifest SHA-256 is `478b0187b10cab6f44587c172ceb76a401ab34be9c5845c89e38da3f78fb180c`; UI output is `3f7f5912e7b4f838bdb3617fe30705a0682f433a782c8a48480390d2ab32e053`; UI source is `c367894da83b32369f0efd15d6c8213184933b17e1553f668e62747352b1dd01`. The manifest records before/after hashes. The cached archive builder was not run in place. Old consumed/expired packets, receipts and the unused prior image remain untouched.

## Next step and acceptance

The implementer next prepares a concrete fresh image-build/runtime proposal with exact artifact bindings, required permissions, cleanup, cost bounds and a new valid operation window. No such executable packet or external approval is created by this source archive. The consumed old build controller cannot be replayed. The old unused image lacks the repair.

R1-W01 / APP-013/3A remains open. Accepted measures are unchanged: **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. The owner still approves applicable external actions and accepts the authentic same-job Sandbox outcome. Source preparation, tests and commits award no acceptance credit.

Final documentation checkpoint: frozen baseline, cross-repository consistency, all 25 governance safeguard tests, backend governance/architecture and both repository whitespace checks pass. The previously recorded 97 application tests and 22 real-role checks were not rerun for this evidence-only addition.
