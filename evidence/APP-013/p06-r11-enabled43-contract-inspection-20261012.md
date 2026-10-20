# APP-013 / 2B / P06-R11 — enabled43 contract inspection

Status: bounded source/contract inspection complete. No runtime code, test, deployment, database, provider, or customer action was performed in this step. No scope deviation.

## Traceability and result

The applicable criterion is 2B: a protected customer journey verifies current phone and eligible-address evidence, then creates exactly one job from the reviewed draft only when required fields and approved policy pass. Invalid or uncertain input must not create a job; recoverable address input must remain correctable.

The one enabled43 request returned HTTP 200 at the transport layer, but its response body was not retained in the Cloud Run request logs. The exact staging-branch SELECT found no job row or admission audit for the bounded interval. The browser private session expired, so its exact post-submit message cannot now be recovered. The reviewed street field looked incomplete; that is a possible cause, not evidence of the actual refusal.

## Source map and existing behavior

- The packaged browser collects street, unit, city, and postal code, checks the required street/city/ZIP fields, renders the reviewed address, and sends the exact confirmed address and draft with one request ID to `/customer-session/submit`.
- Server composition binds tenant and integration identity. The submitted session token is checked against that tenant; the browser cannot select the tenant or server identity.
- The controlled path validates that the submitted draft address matches the reviewed address, verifies phone/address/coverage through its controlled services, and creates the audit and job in the admission transaction only after those checks pass.
- The deployed image in the enabled43 package was `sha256:ac802ed03e70f96dff6e268bbeb6284cd7737492b84972ae572b8609639abe5e`, built from the street-record archive. Its manifest includes `scripts/fixtures/customer-intake-journey.js` at SHA256 `9e44beb4d0849cd1dc3275135da71b272fdae435f3aaacb456d48713b8df6d85`.
- That browser code already renders safe, distinct messages for `ADDRESS_REVIEW_UNAVAILABLE`, `SERVICE_AREA_NOT_CONFIRMED`, `OUTSIDE_SERVICE_AREA`, and `ADDRESS_CORRECTION_STATE_UNAVAILABLE`, and an outcome-unconfirmed message. `scripts/verify-controlled-intake-ui.mjs` has synthetic cases for these outcomes and asserts the resulting feedback. The existing street-record repair separately broadens the supported record-type predicate from H to H/S; it does not prove or fix the enabled43 refusal.

## Change decision and next observable result

No additional UI patch is justified by current evidence: the source already has reason-specific refusal handling and synthetic coverage, while the exact response for enabled43 is unavailable. Do not add customer-address, phone, provider-response, or raw response-body logging to infer the cause. A separate diagnostic/retention design would need its own explicit review before implementation.

No additional local code or test is proposed. Existing relevant checks to reuse if a demonstrated UI gap emerges are `src/communications/controlled-intake-browser-result.spec.ts`, `src/communications/customer-consent-browser-transport.spec.ts`, and `scripts/verify-controlled-intake-ui.mjs`. The next observable acceptance result remains one correlated protected journey with its exact browser outcome and one-or-zero job evidence. The consumed enabled43 package must not be replayed; a new journey needs fresh owner authorization and a new bounded package.

Section 2B remains incomplete; R11/full R12 remain open; accepted 1A/1B/2A remain 3/8. Implemented/local synthetic behavior is not live acceptance. No code change or scope expansion is authorized or proposed here.
