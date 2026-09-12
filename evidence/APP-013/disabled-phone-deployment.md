# Disabled phone candidate deployment — 2026-09-12

Owner reviewed the worker fix and approved proceeding with the referenced disabled deployment proposal. Scope: one build, temporary listed build grants, USD 2 operational allowance, zero-normal-traffic candidate. Not phone activation, migration or send approval.

## Immutable release

- Source d33ecd067cdb87054fbce8b3df63f757a28c0277, git archive of tracked source only; existing focused branch/PR #21, no merge.
- Build 688616b2-30e1-4172-abd4-8c1765713348 SUCCESS; E2_HIGHCPU_8, 1200-second timeout, one attempt. Started 19:46:41Z, finished 19:48:38Z.
- Image us-east5-docker.pkg.dev/signmons/signmons/signmons-calldesk-backend@sha256:25e194acfd96299bb670de84e63b932d9dc69528e6f421ae42699f80fc9b3d75.
- Cloud Run signmons/us-east5/signmons-calldesk-staging, revision signmons-calldesk-staging-phone-d33ecd0, tag phone-preflight, Ready=True.
- Runtime signmons-calldesk-runtime@signmons.iam.gserviceaccount.com unchanged. Request-based CPU throttling, revision max one, no minimum instances.
- Normal traffic remains 100% on signmons-calldesk-staging-app013bounds. All eight existing tags/revision assignments preserved. No webhook URL change.
- Verified false: BACKGROUND_WORKERS_ENABLED, STAGING_PHONE_TEST_ENABLED, SMS_DELIVERY_ENABLED, SCHEDULING_ENABLED, DEV_AUTH_ENABLED, STRIPE_WEBHOOK_LIVEMODE.
- Dedicated session/digest secrets pinned at version 1. Existing credentials unchanged. No phone policy or phone-specific Twilio credential mapping added; not a ready-to-send configuration.

## Results and limits

Fresh local lint/build/architecture and full Jest passed: 2,080 passed, three existing skips. HTTPS candidate /health/liveness and /health/readiness returned 200; POST {} to both /communications/staging-phone-test/operations and /stop returned 401 with sanitized refusal and private, no-store. No authenticated session was issued: these prove auth refusal, not an authenticated live OTP test. No UI change/browser QA claim.

Corrected digest and disabled worker flag verified. Focused tests from the source prove zero worker collaborator calls. Initial candidate log query found no ERROR/cleanup-write/recovery-failure matches; this is not a database-wide no-write audit or a full 30-minute observation. Shared serving revisions still operate normally. No test/customer/job records were created by this procedure. Readiness performs a database read; no migrations ran.

Temporary roles/logging.logWriter (project), roles/artifactregistry.writer (repository), and roles/storage.objectViewer (source bucket) were added only to signmons-build for the build, then removed. Account disabled again; resource-policy readback matches baseline memberships. No Owner/Editor or signing grants added. Existing source/image artifacts retained; storage charges can continue. Compute reference is approximately USD 0.031 at the reviewed rate, excluding storage/runtime/logs/transfer/taxes; final account billing not verified and USD 2 is not a provider hard cap.

## Review and next

Inspect revision digest, false flags, pinned secret names/versions and traffic in Cloud Run; open only the candidate health endpoints for a read-only check. Existing traffic needs no rollback because it never moved. If abandoning the candidate, removal of exact phone-preflight tag/revision and build artifacts is a separate cleanup decision; do not delete other revisions/artifacts.

Next is the exact short-window activation packet: current participant/notice, US-only Verify/Fraud Guard, private session/operator/tenant policy and credential mapping, capped single-SMS approval and stop/cleanup plan. No new feature section. Identity and tenant were not activated, no session issued, no provider send/payment/calendar action. APP-013/2B Now, 3/8 walkthrough accepted (37.5%), not overall MVP completion. Google/county admission gates remain separate.
