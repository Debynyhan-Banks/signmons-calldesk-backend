# APP-013 / 3A / P07 entry inspection

October 20, 2026. The required same-job Sandbox payment entry inspection is complete. This is source/configuration/test planning evidence only: no application source, provider, secret, database, deployment, charge, customer or appointment action occurred.

## Result

The existing payment stack is reusable, but P07 is not implementation-ready without the bounded fixes recorded in governance `APP013_3A_PAYMENT_SECTION_CARD_20261020.md`:

- Enabled52's accepted controlled job records the current approved payment policy timestamp/digest but has no payable pricing/policy snapshot. The existing binder is local-only, unregistered and requires a human-reviewed intake marker that the correctly deterministic 2B job does not have.
- The dispatch flow cannot recover an active pre-booking Checkout URL after a lost response or reload; each UI request creates a new client idempotency key, while the existing customer recovery path requires a later appointment-management capability.
- The webhook handler verifies signature, time, mode, connected account and money, but payment lookup permits metadata-only fallback instead of requiring the stored Stripe resource for the event type.
- Exact Sandbox account/configuration readiness remains unverified and separately approval-gated.

Existing positive boundaries remain: Checkout Sessions, direct connected-account charge with zero application fee, dynamic payment methods by omission, server-derived money, server-side secrets, informational redirect, required signed webhooks, duplicate event suppression, bounded event visibility and persisted payment-gate enforcement.

## Source anchor

Focused backend HEAD is `3cf8a9dc53d0282a35e6263a36d749c5b32f8e2e`; branch `codex/p06-r08-recovery-20260918` is seven commits ahead of its remote and the worktree has substantial pre-existing mixed changes. Payment source and UI files inspected for this card are otherwise clean. `customer-intake-continuation.service.ts` has pre-existing uncommitted controlled-intake work and was read without modification. Governance HEAD is `8d7c644ecc8e65ec139bcfcc3fef055ad5d423cd`, also seven commits ahead with substantial pre-existing mixed changes.

Inspected content hashes are preserved in the governance card. Relevant history includes merged APP-012 payment commits through `65da225`, later webhook-mode hardening `27d595d`, policy binding `b61bb55`, scheduling gate changes `3037651`/`bb88594`, and current focused source at `3cf8a9d` plus the preserved uncommitted controlled-intake change set.

## Validation

- Backend governance baseline and cross-repository documentation consistency: pass before the card.
- Focused payment tests: 3 suites, 39 tests passed (`payment-requests.service`, `stripe-checkout.provider`, `stripe-webhooks.service`).
- Source review covered controller/module registration, raw webhook body setup, environment mode validation, tenant connected-account fields, dispatch request/recovery UI, informational payment-return page, customer recovery path, payment gate and the controlled admission/policy-binding seam.
- Stripe integration review confirmed that the current flow appropriately uses Checkout Sessions, omits `payment_method_types`, requires verified webhooks for payment truth, and does not fulfill from the redirect. No SDK/API upgrade is included in P07.

Post-card documentation/architecture/whitespace results are recorded in the handoff. Browser QA is not applicable to this documentation-only checkpoint; responsive fixtures are required after P07 code changes.

## Review boundary

Review the three demonstrated source gaps and the finite patch/test matrix in `APP013_3A_PAYMENT_SECTION_CARD_20261020.md`. Next permitted work is the bounded local P07 implementation. Exact Sandbox inspection/execution remains a later owner-approved step; do not access Stripe, create Checkout, deliver a test event or use the admitted job externally from this card. Accepted progress remains 6/60, 4/8 and 0/13. **No scope deviation.**
