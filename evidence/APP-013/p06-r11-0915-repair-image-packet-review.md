# P06 / R11 9:15 AM repair-image build and packet review

Date: 2026-09-21

Status: the one approved repair-image build succeeded, temporary access was removed and read back absent, and a fresh private R11 packet is review-ready. Execution is not authorized.

## Traceability

- Approved section: APP-013/P06 R11, within the existing 2B connected intake journey.
- Acceptance criterion: demonstrate one correlated protected phone-verification, eligible-address and reviewed-submit journey that creates exactly one job, followed by mandatory closeout. This checkpoint supplies the repaired immutable image and exact review packet; it does not satisfy R11.
- Inspected gap: the prior enabled11 image came from pre-repair source `53037fb` and would repeat the demonstrated category-binding refusal. Backend `1819e84b232bf98112c44fc52641b788b35b8b38` contained the approved fix but had no immutable registry artifact.
- Connected-workflow advance: enabled12 is now bound to the repaired source/image and one fresh finite window, so a separately approved supervised run can test the same phone -> address -> reviewed-submit path without reusing a consumed artifact.

## One approved build

The owner approved one Cloud Build during 9:15–9:45 AM Eastern from exact clean source `1819e84`, using the existing `signmons-build` identity, `E2_HIGHCPU_8`, a 1,200-second timeout and tag `p06-r11-1819e84b232b`. Source archive SHA-256 was `2132b8c0e1f8904a2afd9ca92cb78e2e06439af52c24403dfa3e9aa7c14d8ad5` across 618 archive entries.

Build `91773a6b-70dd-4df4-bef6-5cba98b6f5df` was submitted once at `2026-09-21T13:18:30.062558087Z`, started at `2026-09-21T13:19:25.602577420Z` and finished `SUCCESS` at `2026-09-21T13:21:35.009490Z`. Artifact Registry independently read back tag `p06-r11-1819e84b232b` at immutable digest `sha256:9e9039a3978108067be710532d40b4881a06842b80edd71c029d76632ef11f32`.

The exact temporary `storage.objectViewer`, `artifactregistry.writer` and `logging.logWriter` memberships were removed after the terminal result. Bucket, repository and project policy readback found all three absent. No retry occurred. The build did not deploy or change Cloud Run traffic, tags or configuration.

## Fresh private packet

Private packet `d150e76e-a50c-4927-91b8-c8c2e84d778d` and plan `349fb681-ffe6-46dc-8b83-202ebf3cdf71` are stored under `/Volumes/Signmons-P06/r11-supervised-run-20260921-0915`. The packet binds source `1819e84`, immutable image digest `sha256:9e9039a3978108067be710532d40b4881a06842b80edd71c029d76632ef11f32`, fresh revision `signmons-calldesk-staging-app013p06enabled12`, support from 9:15–9:45 AM Eastern, one connected runtime from 9:25–9:40, and mandatory closeout by 9:45.

Packet digest is `ab3d04c8035c9f8f6ef10109b53485f4b5a34a9931e20e7592adb3632a5e73cb`; runtime digest is `d43900b72b46d41bd35bb6d0994debb53dce10cc2eadd064015b2a71467f58be`; phone approval digest is `4b1f1fbb37dcc168e6898f4668949e61b4f883bfc8f5d725ae4a668c479cbfb9`. These are packet and approval digests, not a participant HMAC.

The private directory contains exactly `runtime-packet.json`, `r10-review-plan.json` and `packet-preparation-result.json`, all mode 0600. No helper, owner approval, action authorization, attempt or result file exists. The existing HMAC-only participant binding is retained privately; no phone is present in repository evidence.

Read-only preparation preserved the prior safe baseline: normal traffic 100% on `app013bounds`, enabled tag absent, required secret-version metadata enabled, one unchanged verified recipient, one Verify service protected by Fraud Guard, United States SMS monitored and United States voice disabled. No secret payload or current database state was read. Guarded execution must recheck current policy and inactive authority before any activation.

## Validation and finish

- `npm run build` passed after packet creation.
- `node --test scripts/p06-runtime-packet.test.mjs scripts/p06-r10-controller.test.mjs` passed 31/31.
- Production `reviewPacket` reproduced all three packet digests; `reviewR10ControllerPlan` accepted the exact controller subset.
- Private file-set, mode, revision, source, image digest and phone-absence checks passed.

Exact approval or refusal of plan `349fb681-ffe6-46dc-8b83-202ebf3cdf71` is required next. Any execution approval must separately name guarded helper/authorization installation, database LOGIN, activation/readback, zero-traffic deployment/readback, the one supervised journey and mandatory closeout. No automatic retry.

No LOGIN, database connection/mutation, activation, deployment, traffic change, provider request, verification code, browser/customer action, job, payment, booking, dispatch, message or secret access/change occurred. P06 remains 12/14 with R11 and full R12 open. Original dirty APP-010 checkout preserved. No scope deviation.
