# Real owner phone verification — 2026-09-12

## Result

One explicitly approved SMS START returned HTTP 201/PENDING. The owner entered the received six-digit code in a private native dialog; one CHECK returned HTTP 201/APPROVED, bookingAuthorized=false and deliveryAuthorized=false. STOP returned HTTP 201/stopped=true. Runner completed exit 0. No automatic resend, payment, appointment, calendar action or confirmation message.

Private US phone normalization/confirmation ran before access setup. Raw phone, OTP and credentials were not logged. The initial authenticated disabled-service probe with the required operation envelope returned 503. The temporary signBlob-only grant used the fixed 22:36–22:51 UTC window and seven-minute propagation wait. The exact isolated Firebase identity was verified before use.

## Resources and closeout

- Existing phone-preflight tag on signmons-calldesk-staging, us-east5, project signmons. Same immutable image sha256:25e194acfd96299bb670de84e63b932d9dc69528e6f421ae42699f80fc9b3d75; no rebuild.
- Existing Verify service ending 04f0/account ending c417; no new number, service or provider configuration.
- Latest ready cleanup revision signmons-calldesk-staging-00065-guw. Normal traffic remains 100% signmons-calldesk-staging-app013bounds.
- All six safety flags false: background workers, staging phone, SMS delivery, scheduling, dev auth and Stripe live-mode webhooks. Temporary phone policy and phone-specific Twilio token mapping removed.
- Isolated tenant a1adcfd4-15be-404b-9ac3-5edb1fda20f0 read back SUSPENDED, approval enabled=false. One session exists and is closed. Audit counts: one staging_phone_held, two verification_reserved, two verification_observed, one phone_test_stopped. Evidence/liability retained; no record deletion.
- Operator staging-phone-owner-20260912 disabled and refresh credentials revoked, validSince 1789253204. Runtime service-account resource bindings empty; stagingPhoneTokenSigner role DISABLED. Reuse of issued token returned 401.

## Cost and limits

USD 0.50 was the application liability ceiling, not a provider invoice hard cap. Actual billed cost has not been reconciled. Retained liability means a future run must not silently reset/reuse this packet. No new send is authorized.

This passes the real phone subcheck only. APP-013/2B address/county/current-proof admission is not accepted by an OTP result. Walkthrough stays 3/8 (37.5%); that is milestone acceptance, not total MVP effort. Next is review of remaining existing 2B admission gates, not a new feature or release.

## Validation

Real native-dialog/provider/API execution and independent Cloud Run/database closeout readback passed. Only the runner's fixed execution window changed in code; no application source/schema change. Syntax checks and private-phone unit tests plus governance consistency/check tests are run for this closeout. Full runtime lint/build/test suite was not rerun; prior deployment evidence remains historical.
