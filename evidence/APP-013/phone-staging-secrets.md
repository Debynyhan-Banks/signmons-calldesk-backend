# Dedicated staging phone secrets — 2026-09-12

Owner explicitly approved creating the two named staging secrets and granting narrowly scoped runtime read access. This authorization did not include deployment, test-identity activation, session issuance or sending.

## Verified results

Project signmons; user-managed replication in us-east5; purpose=staging-phone-test.

| Runtime environment mapping (not deployed) | Secret | Version | State |
| --- | --- | --- | --- |
| STAGING_PHONE_SESSION_KEY | signmons-staging-phone-session-key | 1 | ENABLED |
| STAGING_PHONE_DIGEST_KEY | signmons-staging-phone-digest-key | 1 | ENABLED |

Each value was independently generated from 32 cryptographically random bytes, hex encoded and supplied to Secret Manager over stdin. Values were read back and compared in memory, with buffers cleared afterward. No values, fingerprints, passwords or bearer tokens were printed or written to files/repository. No existing secret was changed, rotated or duplicated.

Each secret's resource IAM policy was read back and contains exactly one binding: roles/secretmanager.secretAccessor for serviceAccount:signmons-calldesk-runtime@signmons.iam.gserviceaccount.com. No project-wide role, service-account token-signing grant, build-account change or other IAM mutation occurred. This verifies the resource policy, not an impersonated runtime access test; inherited project permissions are not removed or claimed absent.

Secret version ENABLED means available in the vault, not enabled phone sending. No Cloud Run environment was modified or deployed. Existing Twilio credential remains unchanged. Isolated operator staging-phone-owner-20260912 was not enabled; tenant a1adcfd4-15be-404b-9ac3-5edb1fda20f0 was not activated. No session, customer, conversation, job or OTP was created this run.

## Checks and next boundary

Both exact names were absent before creation. Creation, version readback, byte comparison and exact resource-policy checks all passed. Documentation consistency/eight governance regressions and whitespace are the applicable repository gates. No runtime/UI code changed; prior runtime tests are not claimed rerun. No browser QA applies to these vault operations.

Next is the exact disabled, zero-normal-traffic candidate deployment proposal, including reviewed source/image, build identity/temporary grants and any build/storage spending authorization. The build account is currently disabled; no permission to enable it is inferred from this secret approval. Pin the above secret versions rather than latest in the reviewed candidate. Keep phone test, general SMS delivery and scheduling disabled until separate test activation approval. Generate the short-lived private session only after deployment readiness, not now.

Secret storage/access charges may apply separately from the proposed USD 0.50 OTP application ceiling. After test or abandonment, review exact-resource disable/cleanup with identity cleanup and evidence retention; no cleanup automation or broad deletion created. APP-013/2B remains Now; 3/8 (37.5%) milestone acceptance, unchanged. Stripe Checkout stays the MVP payment flow.
