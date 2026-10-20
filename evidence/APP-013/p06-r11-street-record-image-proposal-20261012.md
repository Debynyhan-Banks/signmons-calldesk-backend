# APP-013 / 2B / P06-R11 — street-record image build proposal

Status: Alternative1 completed once during the approved October12 window. Exact source/image verified and all three temporary grants independently verified absent. No deployment or live journey authorized.

## Traceability and exact source

Owner authorized the local S-and-H repair and synthetic tests, then requested this build/release proposal. Existing section2B requires current phone and eligible-address evidence followed by exactly one reviewed job; creating an image advances release readiness only. Runtime delta: exact S street record accepted alongside H, with all other gates unchanged. Unsupported F/G/P/R and malformed types remain UNKNOWN. The historical live refusal cause remains unknown.

Source HEAD `3cf8a9dc53d0282a35e6263a36d749c5b32f8e2e` is insufficient by itself because the focused checkout contains preserved dirty work. Freeze is defined by:

- archive `/private/tmp/r11-street-record-image-review-20261012/source.tar.gz`
- SHA256 `8def873d3786480945216c3937306ef4b45f28d28c8edb0e53744c86fc696b36`
- 983767 archive bytes; 576 files; 4600056 source bytes
- manifest `/private/tmp/r11-street-record-image-review-20261012/manifest.json`
- exact candidate `us-east5-docker.pkg.dev/signmons/signmons/signmons-calldesk-backend:p06-r11-street-8def873d3786`

The prior approved576-file inventory is reused; exactly the four files in the approved local repair differ. Dockerfile, locked dependencies, build config and all other manifest inputs are byte-identical to the previous reviewed image source. Current checkout, extracted files, manifest and repair after-hashes independently match. Archive paths/types/modes and normalized timestamps/ownership were checked. No symlinks, repository metadata, environment files, dependencies, output, evidence or private results are included. Archive is compressed with a fixed timestamp and is immutable for this proposal. Existing node22 base/build-tool tags are unchanged and not digest-pinned; deterministic source does not promise a byte-identical future container image.

Local repair evidence: `evidence/APP-013/p06-r11-street-record-repair-20261012.md` (288 focused tests,2604 full tests/3 existing skips,28 connected browser cases,0 live provider calls, disposable cleanup). Those tests were not repeated for packaging. Fresh extracted-archive `npm run build`, `npm run lint`, `npm run arch:check` pass with a local copy-on-write dependency copy. Source artifacts and logs: `/private/tmp/r11-street-record-image-review-20261012`.

## Alternative1 — one build only

Owner approves the exact archive/tag above, one source upload/build submission, USD1 Cloud operational allowance, three temporary memberships with mandatory removal/readback, no retry and a future45-minuteEastern window.

Finite sequence after approval:
1. Prepare fresh operation/plan identities and one-use controller bound to owner decision, archive/manifest hashes and exact window. Reuse the reviewed prior build-controller flow; never execute or modify consumed packages. Require local no-action tests for early/late/consumed state, archive/source drift, tag collision, grant failure, uncertain submission and cleanup failure. Start within the first20 minutes, leaving at least25 minutes for the20-minute build timeout and cleanup. No re-approval of routine implementation inside this exact boundary is necessary.
2. Fresh read-only preflight, project `signmons`: build identity `signmons-build@signmons.iam.gserviceaccount.com` enabled; existing bucket `signmons_cloudbuild`; existing Docker repository `us-east5/signmons`; candidate tag absent; all three temporary memberships absent. Current state was not refreshed during preparation. Any mismatch stops before mutation; no repair/re-enable/replacement resource is implicit.
3. Journal before each mutation and grant only `roles/storage.objectViewer` on `gs://signmons_cloudbuild`, `roles/artifactregistry.writer` on repository `signmons` in `us-east5`, and `roles/logging.logWriter` on project `signmons`, all to the existing build identity. Do not add runtime permissions or broaden scopes.
4. Submit the exact local `source.tar.gz` archive once, not the mutable checkout or a repackaged directory, through `gcloud builds submit` with the bound extracted `cloudbuild.deploy.yaml`, `_IMAGE` candidate above, explicit `--region=global`, `e2-highcpu-8`, `--timeout=1200s`, existing build service account and source staging bucket. The CLI performs the single source upload; any uncertainty consumes the attempt. Preserve build ID and source object/generation. Verify the uploaded archive's bound bytes/checksum and source provenance; require the build and registry immutable digests to match. No automatic retry or alternate source/tag/identity.
5. In mandatory cleanup after success/failure/uncertainty, remove every possibly applied membership and independently read all three absent. Cleanup remains authorized beyond the normal window if needed. Preserve sanitized result/stop and source/build/digest receipts. Do not delete or overwrite prior evidence.

Observable finish: one unused immutable image bound to the archive and all three grants absent, or a terminal stop with cleanup status. Owner controls external authorization; implementer owns one-use preparation, execution evidence and cleanup. Actual cloud readiness remains a preflight dependency. A stopped/uncertain submission cannot be retried under this approval.

## Costs and boundaries

Google's published default-pool e2-highcpu-8 price is USD0.0156/minute:20 minutes computes to USD0.312 before storage/logging/registry/transfer/tax or account adjustments. USD1 is the proposed operational allowance, not a provider-enforced invoice cap or verified invoice estimate. Twilio/address allowance is USD0; no account balance or provider API is read. Pricing checked October12: https://cloud.google.com/build/pricing . CLI explicitly supports local archive submission: https://docs.cloud.google.com/sdk/gcloud/reference/builds/submit .

This action reads no application database, secret payload, participant/customer/job data. Expected retained outputs: source object, build logs, immutable image and sanitized receipts. No request/correction data is uploaded. Excluded: deployment/Cloud Run revision/tag/traffic changes, runtime activation, secret changes, migrations, customer contact, phone/address provider calls, browser journey, booking/payment, hold release/reset, ceiling changes, repository commit/push/merge and retry.

October12 reconciliation snapshot remains phone19/USD9.50 and address12/USD1.20 held; these are not invoices or current balance. Phone ceiling is reached; no new headroom is inferred. That snapshot and the previously verified runtime closeout are not a new live qualification.

## Alternative2 and later release

Alternative2 retains the local archive without cloud work. After any successful approved build, readiness/deployment and a later attended journey require separate current-state review and owner approval bound to the returned image digest. This proposal supplies neither. The existing normal-traffic service remains untouched; rollback is leaving the candidate unused and restoring the three temporary grants to absent.

Completed: exact archive/manifest/delta preparation and extracted-source checks. Remaining: owner selects Alternative1 with a future45-minuteEastern window or Alternative2. Next observable result after approval is a locally checked one-use build operation, then one unused image plus verified permission cleanup. No acceptance increment: P0612/14, R11/fullR12 open, accepted1A/1B/2A3/8. No scope deviation.

## October12 — owner-approved street-record build prepared for 7:30–8:15 a.m. Eastern

Owner explicitly approved Alternative1, exact archive/tag, one build, three temporary grants with verified cleanup, USD1 allowance and no retry for October12 7:30–8:15a.m.Eastern (11:30–12:15UTC). Plan `5e4dfc9c-9a05-4727-ba35-24589d67fbff` / operation `d38d4bd3-43fe-4861-b2f7-2f8300181b12`; control `/private/tmp/r11-street-build-control-20261012-0730`; reserved result path `/private/tmp/r11-street-build-run-20261012-0730`. Start strictly before7:50; mandatory cleanup may continue beyond8:15.

One-use controller binds the owner text, archive/tag/hash, source manifest and controller hash. It reuses the prior build flow, submits the exact compressed archive with explicit global region, and verifies the uploaded source generation/bytes/SHA256 and build/registry digest.11 synthetic lifecycle cases and7 source-binding subcases pass; installed no-action check passes. No live action or attempt exists at preparation. Old consumed packages remain untouched. This approval includes scoped preflight/grants/one submission/digest verification/mandatory removal and independent readback only. Deployment, provider/database/customer actions remain excluded. P0612/14,R11/fullR12open,accepted3/8. No scope deviation.


## October12, 7:34 a.m. Eastern — approved street-record image built; cleanup verified

APP-013 /2B/P06-R11: owner-approved plan `5e4dfc9c-9a05-4727-ba35-24589d67fbff` / operation `d38d4bd3-43fe-4861-b2f7-2f8300181b12` completed once inside the7:30–8:15a.m.Eastern window. Fresh preflight passed; one submission created build `0d11d3f7-673b-4eff-9173-09661b7226fd` with terminal SUCCESS. Candidate `p06-r11-street-8def873d3786` resolves to `sha256:ac802ed03e70f96dff6e268bbeb6284cd7737492b84972ae572b8609639abe5e`.

Uploaded983767-byte archive SHA256 `8def873d3786480945216c3937306ef4b45f28d28c8edb0e53744c86fc696b36` was downloaded from its exact recorded source generation and matched; build source provenance and registry/build digests agree. All three temporary storage/artifact/logging memberships were removed and read back absent by7:34:08; independent readback at7:34:20 confirmed build SUCCESS, digest/provenance match and each grant absent. No retry or deployment. USD1 was the operational allowance; actual invoice cost is unverified. USD0 Twilio/address actions.

Immutable receipts: `/private/tmp/r11-street-build-run-20261012-0730`; proposal/evidence `APP013_P06_R11_STREET_RECORD_IMAGE_BUILD_PROPOSAL_20261012.md` and backend `evidence/APP-013/p06-r11-street-record-image-proposal-20261012.md`. Build checklist complete; operation consumed, never rerun. Image remains unused. Next: a separately reviewed digest-bound readiness/deployment proposal, with current-state preflight and explicit owner approval before external actions. No new journey, allowance/headroom, runtime activation, database or provider action authorized. P0612/14,R11/fullR12open,accepted3/8. No scope deviation.
