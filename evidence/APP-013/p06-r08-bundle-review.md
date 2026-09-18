# P06 / R08 delivery-bundle packet review

## Verified result — 2026-09-18 7:36 PM Eastern

- The owner explicitly approved operation `60da3dd4-5bd1-473b-a926-2d5c6affa2b1` for 7:30–7:45 PM Eastern and manually invoked the guarded wrapper once inside that window.
- The wrapper emitted `BUNDLE_VERIFIED_NO_ACTIVATION`. The encrypted reservation was created at 7:36:02 PM Eastern, before source access, and records the exact approved operation, source revision and window. The sanitized result was written at 7:36:04 PM Eastern.
- Private readback verified destination `projects/signmons/secrets/signmons-staging-controlled-intake-material/versions/1` byte-for-byte against the four exact numeric source versions. The sanitized receipt is retained as `p06-r08-bundle-result.json`; its SHA-256 is `e919ef22f1b40b5a36a72fddaa0435335c17657ca8e3c044d104a31221dbd763`. It contains no secret value, phone or participant binding.
- R08 is complete: the earlier isolated bootstrap and this verified delivery bundle satisfy its approved provisioning boundary. P06 is 11/14 complete; R10, R11 and R12 remain open. The packet's 8:00–8:15 PM runtime envelope does not authorize R10, activation, deployment, LOGIN, paid verification, a verification code, an address request or customer/job action. No scope deviation.

## Bounded section card — 2026-09-18

- Approved section: APP-013 / P06 / R08, existing U01 delivery-bundle preparation. The owner said `proceed` after reviewing the next governed steps. This authorizes the local/private review checkpoint only; it does not authorize a Secret Manager version write, source-secret payload access, runtime activation, provider verification request, deployment, database LOGIN, SMS or customer action.
- Acceptance criterion advanced: bind the already approved tenant policy, fixed runtime proposal, numeric purpose versions and verified participant HMAC into the exact U01 packet that can be reviewed before one guarded bundle operation. This supplies controlled runtime material only; it cannot create a session/job or grant R10/R11 authority.
- Inspected missing behavior/evidence: `participant-binding.json` now exists, while no delivery bundle/result exists. `policy-bindings.json` still listed participant binding and final packet as pending. The existing `reviewPacket`/`prepareBundle` interface requires one exact envelope, runtime facts, source revision, source-version set, destination resource and forbidden-resource set before it can reserve or read any source value.
- Connected workflow: a verified bundle gives the disabled candidate one source-bound private map for later R10 deployment/activation review. The actual phone -> address -> reviewed submit -> one job journey remains R11 and cannot begin from this packet.

### Source, reuse and exact artifacts

- Executed operator source remains `59f2dabc022e3c9d91a1233aece6d8c67fe6c3b4`; later backend `aec1342` only recorded the binding result. All 713 compiled hashes remain bound to `59f2dab`, and the current checkout has no operator-script difference from that source.
- Reused interfaces: `scripts/p06-runtime-packet.mjs::reviewPacket`, `prepareBundle`, `encryptedReservation` and `googleSecretPorts`; `scripts/p06-backup-once.mjs::inspectStorage`; the existing build, policy and participant bindings under the encrypted preparation directory.
- Private mode-0600 artifacts: `runtime-packet.json`, `packet-review-summary.json` and `prepare-r08-bundle.mjs` under `/Volumes/Signmons-P06/r08-bundle-preparation-20260918`. The repository retains only the sanitized summary in `p06-r08-bundle-review-summary.json`.
- Private file SHA-256: packet `852cbb04cb4184d5c608d6fa5e97d7a3b80f723d1aaca7235daac4e13865f136`; summary `9f8f719ebf991f534f4d04b0c97ef593cef88f0428610370857df723e50d09e2`; wrapper `21dceb6ac45ac52844f773ecaa7075516a63cf4326bf98c78c2de0e1869e970b`.
- Exact proposed packet: ID `c538928e-57eb-4288-90d9-38a519bd7720`; digest `79114793da1229844942db69ce04097fe2ed69353c7752e20453b60e66da442c`; runtime digest `cf04c4cf412e67956f756d3ebdb1fd768783a3ce42e520d8a0ce7a1c601b0d11`; phone-policy digest `cca8621259421aa8adad192749c633985784f7ce1847fce97775b4c0400d8745`.
- The earlier unconsumed packets for the expired 4:30 PM and 6:30 PM preparation windows are retained privately. The 6:30 PM authorization expired unused; two pre-window invocations at 5:37 PM and 5:42 PM refused at `PREPARE_BUNDLE` before reservation, source-secret access or bundle write. No delivery bundle or result exists.
- Proposed exact enabled target remains the R07-reviewed name/origin: revision `signmons-calldesk-staging-app013p06enabled`, origin `https://p06-intake-enabled---signmons-calldesk-staging-p572d6wipq-ul.a.run.app`. R10 must still verify the provider-created revision and exact origin before any participant request.

### Exact envelope and boundaries

- Tenant/category/organization/payment bindings are the successful U02 bootstrap readback: the fixed isolated tenant and regular-diagnosis category, organization approval at `2026-09-18T13:14:19.594Z`, payment approval at `2026-09-18T13:14:19.744Z`, and their stored policy digests. Tenant is ACTIVE while controlled runtime and phone approvals remain disabled; runtime role remains NOLOGIN.
- Fixed server-side labels: integration `integration:app013-controlled-intake`; policy `p06-r07-regular-diagnosis-v1`; notice `controlled-intake-participant-notice-v1`; phone rate basis `r07-public-verify-us-20260916`; address policy `google-only-cuyahoga-v1`; address rate basis `r07-public-address-pro-20260916`. These labels identify the R07-reviewed notice/policy/public-rate basis; they are not invoice guarantees or renewed rate evidence. R10 must refresh provider restrictions/rates and stop if the basis changed.
- Phone bounds: one START, up to five CHECKs, no resend; new reserve 500,000 micros and account ceiling 1,000,000 micros including the prior 500,000 hold. Participant identity is the bound HMAC; phone text is absent.
- Address bounds: fixed approved account, 100,000 micros per request, 200,000 micros and two requests at account/tenant/session levels, exact two-attempt eight-second execution. Prior local address holds remain separate and are not reset.
- Browser bounds: total/tenant/session 60, starts 1, in-flight 2. All six safety flags remain literal false. Job creation grants no payment, booking, dispatch or send authority.
- Runtime window embedded for packet validation only: `2026-09-19T00:00:00.000Z` through `2026-09-19T00:15:00.000Z` (8:00–8:15 PM Eastern). `activationAuthorized=false` and `paidVerificationAuthorized=false`; R10 approval remains mandatory.
- Source refs are exactly customer session key version 1, customer digest key version 1, customer email-fingerprint key version 1 and existing Twilio auth-token version 1. Destination is the existing controlled-intake-material resource. Old conversation-encryption, consent-hash, staging-phone session/digest and child-database resources are explicitly forbidden as bundle sources.
- The private packet contains the nonsecret account identifier and participant HMAC but no phone, key, token, access token, source value or authorization record. The repository summary contains neither private binding value.

### Finite checklist, tests and stop behavior

1. Complete: reconcile current governance, build/policy/participant artifacts and the U01 interface; preserve original dirty APP-010 checkout.
2. Complete: construct one exact private packet, validate it with production `reviewPacket`, compute canonical packet/runtime/phone digests, and install the byte-identical mode-0600 packet/summary/wrapper in encrypted storage.
3. Complete: wrapper local preflight verifies clean checkout, unchanged operator sources, all 713 built hashes, encrypted storage, packet/summary digests, disabled authorization flags, no existing result and unexpired windows. Actual host-metadata `--check` returned `BUNDLE_CHECK_PASSED_NO_ACCESS`.
4. Pending owner approval: after the owner reported missing the expired 6:30 PM window, the replacement proposal uses R08 prepare action ID `60da3dd4-5bd1-473b-a926-2d5c6affa2b1`, `2026-09-18T23:30:00.000Z` through `2026-09-18T23:45:00.000Z` (7:30–7:45 PM Eastern), exact packet digest/source above. The prior authorization is archived and does not authorize this operation; no current authorization file exists.
5. After approval only: create the exact mode-0600 authorization file, run `prepare-r08-bundle.mjs --prepare` once. It rechecks numeric source-version ENABLED metadata and zero destination versions, obtains an owner access token in memory, reserves the encrypted operation before source payload access, reads four exact versions, writes one destination version, privately compares readback, clears buffers/auth and stores one sanitized result.
6. On any refusal or unknown upload/readback outcome: fixed-stage phone/token-free stop record, consumed reservation retained, no automatic retry. Reconcile read-only before any separately approved action.

Existing U01 tests cover positive preparation, invalid packet/window/source/ref/resource separation, duplicate reservation, upload/readback uncertainty and redaction. For this documentation/private-artifact checkpoint run the focused U01 Node tests, wrapper syntax/actual `--check`, architecture, governance baseline/consistency/regressions and both whitespace checks. No customer/browser/provider test is claimed because no runtime path is activated.

### Dependencies, exclusions, rollback and finish

- Owner is the approval owner for the exact R08 prepare action. R10 remains a separate final-run approval binding current provider state, exact deployed revision/origin, participant readiness, runtime window and shutdown.
- Exclusions: no bootstrap/credential/provisioning/R09 repetition; no authorization file, source-secret read, bundle upload, new secret/IAM change, deployment, LOGIN, activation, paid request, verification code, Address Validation call, payment, appointment, message or customer record.
- Disabled/rollback state: without `bundle-prepare-authorization.json`, `--prepare` refuses. Deleting the unconsumed packet/wrapper would return to the prior participant-bound/no-bundle state. Once an operation reservation or destination version exists, never delete it to manufacture a retry; reconcile and retain evidence.
- Observable finish for this checkpoint: exact source-bound packet and one-operation wrapper are private, validated and reviewable; owner can approve or decline the named prepare window. R08 remains open until one verified bundle result. P06 remains 10/14; R08/R10/R11/R12 open; accepted packages 5/60 and walkthrough 3/8 unchanged. No scope deviation.
