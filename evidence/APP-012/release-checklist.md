# APP-012 Stripe Endpoint And Release Checklist

Date: 2026-09-07
Branch: `codex/app-012-payment-gate`
State: sandbox acceptance complete; merge and production release remain unauthorized

## Acceptance Decision

APP-012 has a **governed sandbox acceptance pass** for Stripe transport, signature verification, automatic post-destination payment transition and Stripe-originated duplicate idempotency. Owner merge acceptance and production release remain separately approval-gated.

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
| Deployed staging transport | A connected-account destination delivered a genuine Stripe CLI event to the reviewed staging revision; its valid signature passed verification and the unrelated fixture failed closed as unrecognized | Pass |
| Paid-event staging transition | The submitted $100 USD Checkout event was securely replayed against the deployed endpoint after destination creation; it returned 200, transitioned `PENDING` to `SUCCEEDED`, wrote one processed event and one transition audit, and unlocked dispatch | Pass |
| Duplicate staging delivery | Replaying the same signed paid event again returned 200 while event and transition-audit counts remained one | Pass |
| Fully automatic post-destination Checkout | A new disposable $100 USD Checkout automatically delivered from Stripe with HTTP 200, canonical `SUCCEEDED`, one processed event, one transition audit and dispatch unlock | Pass |

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

## Staging Acceptance Evidence — 2026-09-07

- Reviewed commit: `27d595da21406704b6bc66804ba03d2e90643b23`.
- Cloud Build `1d5602ee-dda1-4010-ae0b-2e98230a064d` produced image tag `27d595d`.
- Cloud Run revision `signmons-calldesk-staging-app012correct` serves 100 percent of staging traffic with `STRIPE_WEBHOOK_LIVEMODE=false`.
- Stripe test-mode connected-account destination `Signmons StBox sandbox connected payments` is active at the staging `/webhooks/stripe` URL and listens to the six approved event types. Its signing secret is stored only in Google Secret Manager version 5; no secret value is recorded here.
- A genuine Stripe CLI connected-account event reached the deployed endpoint with a valid signature. The application returned 404 because the generic fixture had no recognized internal payment, proving the endpoint fails closed after transport and signature verification.
- The owner-submitted `$100.00 USD` Checkout was paid before the destination became active, so Stripe showed no historical delivery for it. The exact Stripe event was retrieved and securely signed with the active vault secret for a deployed replay. The endpoint returned 200 and staging verified: `SUCCEEDED`, amount `10000`, currency `usd`, application fee `0`, destination matched the tenant, dispatch unlocked, one processed event and audits `payment.request_created` plus `payment.webhook_transitioned`.
- A second replay returned 200 with the event count and transition-audit count still one, proving deployed idempotency.
- The disposable tenant and Identity Platform operator were deleted after verification (one each). Temporary secret/event files were removed; temporary build and token-signing permissions remain revoked.
- This is a staging acceptance pass for transport, signature verification, canonical paid transition and duplicate handling. It is not a live-mode release and does not replace the separate owner gate for merge, production deployment or a controlled real transaction.
- After the destination was active, a second disposable `$100.00 USD` Checkout automatically delivered `checkout.session.completed` from Stripe to staging. Stripe Workbench recorded HTTP 200 and the application returned `received: true`, `handled: true`, `duplicate: false`.
- Staging independently verified `SUCCEEDED`, amount `10000`, currency `usd`, application fee `0`, destination matched the tenant, dispatch unlocked, one processed event and exactly the request/transition audits. A Workbench manual resend then recorded HTTP 200 with `duplicate: true`; database event and audit counts remained one.
- The second disposable tenant and Identity Platform operator were deleted (one each). The temporary token-signing grant was revoked immediately after fixture creation, staging liveness/readiness remained HTTP 200, and no live-mode or production state was changed.

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
