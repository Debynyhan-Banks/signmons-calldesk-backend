# P06-R11 correction-continuation image proposal evidence

Section: APP-013/2B, P06-R11. This evidence freezes the exact locally tested Docker/build inputs and supports a build-only owner decision. It does not authorize or report an upload, cloud read, IAM change, build, deployment or journey.

## Frozen source

- checkout HEAD: `3cf8a9dc53d0282a35e6263a36d749c5b32f8e2e`
- exact local archive: `/private/tmp/r11-correction-continuation-review-20261011/source.tar`
- manifest: `/private/tmp/r11-correction-continuation-review-20261011/manifest.json`
- archive SHA-256: `48ea0a9bb31c439a1fa5f1f8e543c4ecc582edfb21a9e8e741ca2d652b7911e1`
- file count: 576
- source bytes: 4,599,000
- archive bytes: 5,048,320
- proposed candidate: `us-east5-docker.pkg.dev/signmons/signmons/signmons-calldesk-backend:p06-r11-cont-48ea0a9bb31c`

HEAD alone is insufficient because the reviewed checkout contains preserved mixed dirty work. The archive includes the exact current Docker/build input set and excludes repository metadata, evidence, UI, dependencies, build output, environment files and private results. File types and normalized tar metadata were checked; each manifest hash was independently compared with both the archive and current checkout.

## Reproduction result

An extracted archive copy used a local copy-on-write `node_modules` tree and passed:

- `npm run build`
- `npm run lint`
- `npm run arch:check` (`architecture-check passed`)

The first extraction check compiled but disclosed that `eslint.config.mjs` was absent from the initial archive list. No cloud action occurred. The archive was regenerated with that config, producing the final hash above, then independently reverified and rerun successfully. The superseded initial archive was deleted and must not be used.

The prior implementation evidence remains `evidence/APP-013/p06-r11-correction-continuation-diagnosis-20261010.md`: 187 focused tests, full 2,495 tests/three intentional skips, 52 browser cases and the complete disposable PostgreSQL 18 HTTP/browser harness. Those tests were not rerun as part of this source-freeze evidence; build/lint/architecture were rerun from the final extracted archive.

## Proposed bounded external action

Governance proposal: `APP013_P06_R11_CORRECTION_CONTINUATION_IMAGE_BUILD_PROPOSAL_20261011.md`. It permits nothing until the owner explicitly chooses Alternative 1 and gives a future 45-minute Eastern window. The later operation would use one submission, no retry, a USD 1 operational allowance and only the existing build identity/bucket/repository plus three temporary memberships with mandatory removal/readback. It excludes deployment, runtime/data/provider/customer activity and any phone-ceiling change.

P06 remains 12/14; R11/full R12 remain open; accepted milestones remain 3/8. No scope deviation.

## Completed external result

Owner-approved window: October 11, 2026, 9:00–9:45 a.m. Eastern. Plan `3149c991-cdf8-4da0-979c-7c6fe77fd906`; operation `656aa309-c204-4f5f-a9a3-023394097759`. The controller local binding and nine synthetic early/late/consumed/source-drift/tag/grant/submission/cleanup/success cases passed before action.

Fresh preflight passed at 13:01:52Z. Exactly one submission produced Cloud Build `44569641-ba52-4302-bb02-e4194006c979`, terminal `SUCCESS`, and image digest `sha256:69ef032639e5dcfa2bcaaa5d88d0e438ec62903f08cb44fc5572af1209e332d3`. Registry digest matched. Temporary storage, artifact-registry and logging grants were removed/read back absent by 13:05:58Z. A separate post-controller readback confirmed build success, digest match and all three grants absent.

Sanitized local receipts: `/private/tmp/r11-correction-build-run-20261011-0900`. Controller: `/private/tmp/r11-correction-build-control-20261011-0900`. No retry or deployment occurred. Actual invoice cost is unknown; USD1 was the operational allowance. The image is unused and does not change acceptance. The last verified pre-enabled39 aggregate17/USD8.50 is stale because enabled39 exercised the approved18th hold; a fresh aggregate is required before prospective work. P06 remains12/14, R11/fullR12 remain open and accepted milestones remain3/8. No scope deviation.
