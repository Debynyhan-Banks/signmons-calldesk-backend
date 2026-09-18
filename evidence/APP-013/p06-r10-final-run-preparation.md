# P06 / R10 final-run preparation

## Bounded section card — 2026-09-18

- Approved section: APP-013 / P06 / R10, final run approval. The owner said `proceed` after R08 completed. This authorizes read-only qualification and preparation only. It does not authorize an enabled deployment, database LOGIN, runtime approval write, verification code, Address Validation request, job submission or customer action.
- Exact acceptance criterion: bind the actual deployed revision, packet digest, approved current policies/caps, participant readiness and a fresh absolute UTC window; the owner explicitly authorizes one connected run and its defined shutdown after all prior gates are rechecked.
- Inspected source/evidence of missing behavior: the verified R08 packet's 8:00–8:15 PM envelope cannot be used because R10 was not complete before its start. Current Cloud Run readback has no `signmons-calldesk-staging-app013p06enabled` revision or `p06-intake-enabled` tag. The existing Safari Twilio console session is logged out, so current account ownership, service restrictions and Fraud Guard cannot be claimed from the historical readback.
- Connected workflow: R10 can authorize only the one subsequent R11 phone -> address -> reviewed submit journey. It cannot itself create a job, take payment, schedule, dispatch or send a confirmation.

### Current source and reusable boundaries

- Executed application source remains `59f2dabc022e3c9d91a1233aece6d8c67fe6c3b4`; immutable image remains `sha256:ea47a8371a04f773a5c51fc4f939250b7045eba92d3cbbeb68e49ceb0240be35`.
- Reuse the reviewed U01 `reviewPacket`, `operate`, `fixedChildDatabase` and guarded authorization interface; the verified R08 bundle `projects/signmons/secrets/signmons-staging-controlled-intake-material/versions/1`; R09's no-traffic deployment pattern; existing controlled customer page and same-session runtime.
- Current provider metadata at 2026-09-18 7:47 PM Eastern: Cloud Run normal traffic remains 100% on `signmons-calldesk-staging-app013bounds`; disabled candidate `signmons-calldesk-staging-app013p06disabled` is Ready on the immutable image; enabled revision/tag absent. Bundle version 1 and child database URL version 2 are ENABLED; invalid child version 1 remains DESTROYED.
- Runtime identity project roles remain only `roles/firebaseauth.viewer` and `roles/serviceusage.serviceUsageConsumer`; bundle-resource access remains `roles/secretmanager.secretAccessor`. Address Validation, Cloud Run and Secret Manager APIs are enabled. The old custom staging phone signer role remains DISABLED with only `iam.serviceAccounts.signBlob`.
- Published price refresh: Twilio lists USD 0.05 per successful verification plus USD 0.0083 per US SMS; Google lists Address Validation Pro at USD 17/1,000 after 5,000 free monthly events. These are public list prices, not account-specific charges, invoices or spending permission. The existing packet ceilings remain stricter: 500,000 phone micros and 200,000 address micros, with prior holds preserved.

### Exact behavior and pending bindings

1. Complete read-only checks: repository/governance source, image, Cloud Run traffic/revisions, bundle and database numeric-version metadata, runtime IAM, enabled APIs, custom-role disabled state and public list rates.
2. Owner action pending: reauthenticate the existing Twilio Console privately. Read back the fixed Signmons account/service, SMS-only channel, United States permission and Fraud Guard at action time; do not reveal credentials or token.
3. Owner decision pending: select a future attended block that leaves enough time for preflight, bounded database LOGIN, no-traffic enabled deployment, exact revision/origin readback, runtime approval, one R11 journey and shutdown. The expired R08 envelope is never extended.
4. After items 2–3 only, construct a fresh private packet with a new packet ID/digests/window while retaining the same verified participant HMAC, source versions, policy approvals, caps and destination bundle version 1. Validate it with production `reviewPacket`.
5. Prepare one private guarded invocation that checks clean source/build hashes, provider metadata, no target collision, exact bundle/image/revision/origin and disabled safety flags before any authorized mutation. It must use the existing U01 operator and R09 deployment seams, not a new activation subsystem.
6. Present the exact database-login interval, deployment/configuration diff, activation/revocation operation IDs, paid request allowance, browser journey and shutdown sequence. Owner approval of that exact packet is required before R10 can close or R11 can begin.

### Tests, state, identity and recovery

- Positive gate: fresh packet review, exact provider/account checks, target absence, source/image/bundle provenance, current tenant/category/policy readback, participant match and all six safety flags false.
- Negative gates: stale window, wrong revision/origin/digest/account/participant, target collision, provider restriction/rate change, missing bundle/runtime access, active or partial approval, exhausted caps, unknown deployment/database/provider outcome, unexpected traffic/tag/IAM/config difference.
- Concurrency/recovery: one operation reservation per mutation; no automatic retry. General traffic remains on `app013bounds`. On stop or expiry, revoke controlled approvals, close the customer session, restore runtime role NOLOGIN/limit 0/past expiry, terminate only that role's sessions and read back inactive state. Retain bundle, audit/job evidence and unknown holds; never delete evidence to manufacture a retry.
- Browser proof belongs to R11 after R10 approval: same managed HTTPS page, one START, up to five CHECKs without resend, up to two explicit address requests, explicit reviewed submit and exactly one job or truthful refusal.
- Exclusions: no Stripe call/payment, booking, scheduling, dispatch, confirmation, background worker, general SMS enablement, normal traffic shift, bootstrap/provisioning/R09 repetition, secret payload read/change, IAM change, production migration or unrelated tag/resource change.
- Observable finish for this preparation: current non-Twilio gates are reviewable; Twilio reauthentication and a fresh attended window are the only inputs still needed before constructing the exact R10 packet. R10 remains open. P06 remains 11/14 with R10/R11/R12 open. No scope deviation.
