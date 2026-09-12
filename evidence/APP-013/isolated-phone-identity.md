# Isolated phone-test identity preparation — 2026-09-12

Owner explicitly approved preparing the isolated staging identity. No deployment, sending, credentials generation, identity activation or real-customer action was approved or performed.

## Created and read back

- Identity Platform project: signmons.
- Operator UID: staging-phone-owner-20260912; disabled=true; no email, phone, password hash or login token.
- Claims: tenantId=a1adcfd4-15be-404b-9ac3-5edb1fda20f0, role=owner, stagingOnly=true. These are application claims, not Google IAM roles. No IAM grants changed.
- New application tenant: a1adcfd4-15be-404b-9ac3-5edb1fda20f0, Signmons Phone Test - Isolated 2026-09-12, SUSPENDED, America/New_York. Charges and payouts false. Settings mark stagingOnly and stagingPhoneTestApproval.enabled=false.
- Tenant-scoped counts: zero customers, conversations and jobs. Existing tenant 059c4950-171c-4ff9-a963-20bf6b9d59a6 untouched.
- Database target resolved only through existing signmons-staging-database-url reference on the staging revision; Neon host/database checked against the preparation script before mutation. Existing secret read in memory; no secret printed, changed or newly stored.

## Procedure and verification

scripts/prepare-phone-staging-identity.mjs requires an explicit preparation argument, pins the exact project/staging database host and identity IDs, refuses overwrite, validates any existing records, creates only a disabled passwordless operator and suspended empty tenant, then reads back claims/status/counts. It never mints a token or invokes communications/payments. Do not rerun as a generic fixture generator; future execution must remain within explicit authorization.

The Firebase Admin SDK lookup could not complete with the user OAuth credential; the documented Identity Platform REST lookup succeeded with explicit quota project. Batch creation used allowOverwrite=false. Post-create lookup proved disabled status and exact claims. Database insertion committed and readback passed. The pg driver emitted its existing forward-looking sslmode warning; current driver retains verify-full behavior, no TLS setting weakened.

Runtime baseline remains ad909c8. This is operational identity preparation plus script/evidence only; no runtime/UI change or new deployment. Script syntax/format, whitespace and governance consistency/eight regression checks apply; no new browser or Firebase sign-in acceptance claimed. Prior 2,069 runtime test results remain historical, not rerun for this checkpoint.

## Remaining activation and cleanup gates

The disabled operator cannot sign in, and suspended tenant cannot use the phone path. Dedicated key setup, private credential delivery/session preparation, exact candidate configuration/image and enabling this identity require explicit further approval. Do not substitute a dev-auth token or reuse unrelated customer credentials. Confirm the OTP-only notice and exact short UTC window before the separately authorized single SMS to the owner-confirmed destination ending 3183; retain the USD 0.50 application ceiling.

After the test or abandonment, remove only this exact test operator and tenant through an approved cleanup, with tenant-scoped data inspection and liability/evidence retention first. Until then keep both disabled/suspended. No broad deletion or automatic cleanup job created. Google/county full-admission gates remain separate; Stripe checkout links stay the MVP payment route. Walkthrough 3/8 (37.5%) accepted, unchanged.
