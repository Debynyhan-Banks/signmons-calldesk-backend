# APP-013 / 3A / P07 local payment-wiring implementation

October 20, 2026. The bounded P07 source patch is implemented and locally tested in the focused backend checkout. This is implementation evidence only. No deployment, database mutation, Stripe configuration change, Checkout Session, webhook delivery, charge, booking, customer contact, commit, push or merge occurred.

## Acceptance mapping and result

The approved section is APP-013/3A/P07. The exact criterion remains: the same admitted job opens one authorized Stripe Sandbox Checkout from its approved payment policy, and only an authentic signed event for that exact stored Stripe resource may clear the payment gate.

The demonstrated gaps in `APP013_3A_PAYMENT_SECTION_CARD_20261020.md` are addressed locally:

1. `JobPaymentPolicyService` now accepts either the existing human-reviewed v1 admission or the deterministic controlled-v2 admission only when the saved payment approval timestamp and SHA-256 digest match the current approved tenant policy. It preserves the controlled admission without writing `humanReviewed: true`, writes a version-2 binding/audit receipt, retains stale-version/payment/calendar/concurrency refusal, and is registered through its owner/admin authenticated controller.
2. Operator payment creation now retains one tenant/job-scoped idempotency UUID in session storage until a successful response. An owner/admin/dispatcher protected recovery endpoint revalidates the tenant/job, open job state, pending payment, expiry, stored destination, current tenant account and charges-enabled state, asks Stripe only for the stored Checkout Session, returns only the validated `checkout.stripe.com` URL and expiry, and records a USER audit. It never calls Checkout creation.
3. Webhook lookup is selected by event type. Checkout events require the stored Checkout Session ID; PaymentIntent failure requires the stored PaymentIntent ID; a refund requires the exact stored Charge or, before first charge binding, the exact stored PaymentIntent and an unbound Charge field. Present tenant/job/payment metadata must also match. Metadata no longer selects a payment.
4. The real payment-return page remains informational. No redirect field or browser state can mark payment successful.

Changed source is limited to the existing job policy binder/module, payment request controller/service, webhook service, dispatch API/page, focused tests and the repeatable local browser fixture `ui/scripts/payment-request-recovery-browser-qa.mjs`. No schema, fee, routing, payment-method, SDK/API-version or provider configuration change was made.

## Verification

- Focused policy/payment/Checkout/webhook tests: 4 suites, **65/65 passed**.
- Full backend Jest after allowing required local loopback listeners: **132 suites passed, 1 skipped; 2,611 tests passed, 3 skipped, 0 failed**. The sandboxed first run failed only because seven pre-existing HTTP suites could not call `listen`; the same source passed outside that listener restriction.
- Backend lint, build and architecture check: pass.
- UI lint and production static build: pass.
- Desktop 1440x1000 and mobile 390x844 browser fixture: pass. Both views preserved the same idempotency key across the synthetic first-response failure, recovered the exact active Checkout after reload, showed no horizontal overflow and produced no unexpected application errors. The one expected console resource line per view was the fixture's deliberate HTTP 503.
- The broader UI test runner passed 169/170 checks; its unrelated Calendar-review source scan failed because it used a URL-encoded `%20` workspace path as a filesystem path. Dispatch helper checks passed. This pre-existing harness defect was not changed in P07.
- Governance frozen baseline, cross-repository consistency, 21 safeguard tests and both repository whitespace checks: pass.
- No schema or migration changed, so a disposable database migration proof was not applicable to this patch.

## Remaining boundary

P07 is implemented and locally tested but not live-demonstrated or owner-accepted. The signed-in Stripe context is the Signmons LLC test sandbox/Connect platform with one enabled test connected account, and the user's authorization is recorded as **owner/admin**. Governance proposal `APP013_P07_STRIPE_RUNTIME_QUALIFICATION_PROPOSAL_20261020.md` now defines one separately authorized secret-safe read-only qualification of the exact deployed tenant/destination and webhook/runtime binding. A reviewed build/deployment and exact Sandbox action proposal must precede any policy binding against the retained job, Checkout creation or webhook demonstration.

Accepted progress therefore remains **6/60 packages, 4/8 walkthrough milestones and 0/13 fully accepted pilot rows**. **No scope deviation.**
