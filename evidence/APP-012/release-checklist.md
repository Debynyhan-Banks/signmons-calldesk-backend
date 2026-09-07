# APP-012 Stripe Endpoint And Release Checklist

Date: 2026-09-06
Branch: `codex/app-012-payment-gate`
State: review-ready checklist; no endpoint configured and no release authorized

## Acceptance Decision

APP-012 has a **conditional local acceptance pass**. The implemented contract and sandbox evidence cover the full payment lifecycle in linked, isolated proofs. This is not a claim that one deployed staging transaction has completed the entire path. Staging configuration, a continuous end-to-end staging run, owner acceptance, merge and release remain approval-gated.

## Linked Acceptance Matrix

| Lifecycle step | Evidence | Result |
| --- | --- | --- |
| Operator requests payment | Authenticated compiled HTTP proof used trusted job snapshots, persisted one pending request and one audit, and returned no provider IDs | Pass |
| Direct contractor charge boundary | Checkout provider targets the tenant connected account with `applicationFeeAmountCents=0`; sandbox contractor onboarding and a $100 test Checkout completed | Pass |
| Customer opens existing request | Signed customer-link recovery returns only the same provider-confirmed open, unpaid and unexpired Checkout | Pass |
| Redirect remains non-authoritative | Success/cancel UI states do not mutate payment or claim fulfillment | Pass |
| Stripe proves payment | Genuine Stripe CLI Connect delivery verified the signature and changed an isolated payment from pending to succeeded | Pass |
| Duplicate/mismatch protection | Duplicate events are idempotent; mismatched amount/currency returned 422 without mutation | Pass |
| Dispatch consumes canonical truth | Isolated compiled HTTP proof showed pending locked assignment and succeeded unlocked recommendation | Pass |
| Operator sees bounded status | Dispatch UI shows request state and privacy-safe signed-event history without provider identifiers | Pass |
| Governed exception | Owner/admin plus manual policy plus active Growth+ entitlement can unlock with a distinct audited exception; payment status remains unchanged | Pass |
| Continuous deployed staging flow | Requires persistent endpoint/secrets and an approved staging deployment | Pending approval |

## Required Approval Before Staging Changes

- Owner explicitly authorizes staging deployment, database migration and Stripe sandbox endpoint configuration.
- Confirm the exact staging backend HTTPS URL; endpoint path must be `/webhooks/stripe`.
- Confirm the staging Google Cloud project/service and the rollback revision.
- Confirm who will witness the sandbox Checkout and accept the result.
- Keep APP-013 blocked until APP-012 acceptance and release are recorded.

## Staging Stripe Configuration

- Create a **Connected accounts** event destination in Stripe Workbench; do not select platform-account-only delivery.
- Use the public staging HTTPS endpoint ending in `/webhooks/stripe`.
- Subscribe only to:
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`
  - `checkout.session.async_payment_failed`
  - `checkout.session.expired`
  - `payment_intent.payment_failed`
  - `charge.refunded`
- Store the endpoint signing secret in Google Secret Manager as the staging `STRIPE_WEBHOOK_SECRET`. Never paste it into source, tickets, chat, logs or browser code.
- Set staging `STRIPE_WEBHOOK_LIVEMODE=false`; the application rejects even correctly signed events when their top-level Stripe `livemode` differs from this explicit environment boundary.
- Prefer a dedicated restricted sandbox key with only the Checkout Session create/read permissions actually exercised by this service. Store it in Secret Manager as the staging `STRIPE_SECRET_KEY`; grant access only to the runtime service account.
- Keep sandbox and live keys/signing secrets separate. A CLI listener secret cannot be reused for a Workbench endpoint.
- Record only endpoint name, environment, enabled event types, secret version identifier and approver—not secret values.

Stripe requires a registered webhook destination to use a publicly accessible HTTPS URL and requires signature verification against the exact raw request body. Its key-management guidance recommends server-only secret storage, least privilege and restricted keys where possible:

- <https://docs.stripe.com/webhooks>
- <https://docs.stripe.com/keys-best-practices>

## Continuous Staging Acceptance Run

Use a disposable tenant/job/customer fixture and the sandbox connected contractor account.

1. Apply the committed migrations to staging through the governed migration job.
2. Deploy the exact reviewed commit and verify liveness/readiness before enabling the Stripe destination.
3. Create one payment-required job from trusted policy/pricing snapshots and record its internal reference only.
4. Confirm dispatch is locked and assignment returns conflict without mutation.
5. Create the request as an authorized operator; verify one request audit, zero Signmons application fee and no provider IDs in tracking/event UI.
6. Open the request through the signed customer booking link and complete the sandbox Checkout.
7. Verify one processed signed event, one webhook transition audit, canonical `SUCCEEDED`, operator timeline visibility and dispatch unlock.
8. Replay the same event and verify no duplicate payment/audit mutation.
9. Run separate negative fixtures for invalid signature, live/test-mode mismatch, connected-account mismatch and amount/currency mismatch; each must fail closed before payment mutation.
10. Run failed/expired and refund fixtures; assignment must remain or become locked according to canonical state unless a separately governed exception is active.
11. Confirm success-page navigation alone never changes payment or dispatch state.
12. Remove disposable customer/job/payment data and record fixture cleanup counts.

## Security And Privacy Review

- Search the reviewed commit and build logs for live/test API-key and webhook-secret patterns.
- Confirm no Checkout URL, secure booking token or Stripe provider ID appears in audit/event projections or application logs.
- Confirm operator endpoints require verified authentication, tenant scope and permitted roles; exception approval remains owner/admin only.
- Confirm `STRIPE_WEBHOOK_LIVEMODE` is explicit and agrees with the configured Stripe key mode and intended destination.
- Confirm CORS allows only the approved frontend origins and no endpoint returns environment variables.
- Confirm throttling and `Cache-Control: private, no-store` remain active on operator/status boundaries.
- Verify secret access through runtime identity, then remove any temporary build or operator access used for release.

## Rollback And Monitoring

- Keep the previous healthy Cloud Run revision ready before traffic changes.
- If signature verification, tenant binding or amount validation fails unexpectedly, disable the Stripe destination and route traffic back to the prior revision; do not bypass validation or mark payments successful manually.
- Monitor non-2xx webhook deliveries, retries, processing latency, duplicate rate and failed payment transitions without logging payloads or secrets.
- Rotate the endpoint secret immediately if it appears in any unapproved location.

## Live Release Gate

Do not configure live mode until the continuous staging acceptance run passes and the owner separately approves live release.

- Create separate live restricted key and live Connected accounts event destination.
- Set production `STRIPE_WEBHOOK_LIVEMODE=true` and verify a signed test-mode event fails before any database access.
- Store new live secrets only in the production secret vault and grant least-privilege runtime access.
- Deploy the exact accepted commit/digest, run migrations, verify readiness, then enable the endpoint.
- Use a controlled real transaction only with explicit owner approval; verify canonical webhook status before fulfillment.
- Record commit, image digest, migration job, Cloud Run revision, endpoint configuration metadata, acceptance witness and rollback result.
- Mark APP-012 `Done` only after the acceptance evidence, governance board and global pointer are updated together.
