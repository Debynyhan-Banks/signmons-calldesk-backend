# Atomic staging budget review — 2026-09-12

Owner approved connecting the policy validator to trusted current approval and usage reads. The optional stagingReview configuration remains inactive; no authoring route, production registry, provider registration or new schema exists.

## Implementation

AddressOperationLedger reuses its account/tenant advisory locks, session lock and TenantOrganization SHARE lock. The new staging-address-budget-reader reads settings.stagingAddressBudgetReview = { enabled, packet } inside that transaction. The packet must match the independently supplied trusted runtime approval digest, identity/rate configuration, session and fixture policy caps/rates/expiry. This is review-only material, not secrets or a real spending grant.

Account/tenant/session totals are aggregated directly from operation records without period filters. Reservations and audit writes remain atomic. An existing identity-matched operation subtracts only its own hold/count for the prospective policy check, never from storage, allowing exact retry at a full cap. Invalid/missing/revoked approval refuses before reserve/claim mutation. Tenant settings updates conflict with the held SHARE lock, so revocation and reservation serialize. A revocation committed after an operation transaction does not retroactively undo that transaction.

Policy identity includes the review marker and approval digest. Earlier fixture operations cannot be reused as reviewed operations. Existing outputs remain fixtureOnly, dispatch/address/admission/delivery false, county UNKNOWN. No fixture promotion or provider action.

## Reproduction and observed evidence

Run npm run build, then node scripts/verify-staging-address-reservation.mjs. It requires a local PostgreSQL Unix socket at /tmp for the current OS user; it creates only a validated calldesk_org_<random> database, applies migrations there, and drops it in finally. No environment database URL or production database is used.

Six new assertions passed with fictional records: concurrent cap produces one operation; exact replay at cap; revocation blocks claim with state unchanged; one claim with duplicate refusal; retained liability; changed approval refusal. The same harness ran 13 existing ledger and 11 execution/recovery groups successfully, including cross-tenant limits, old-month holds, rollback and timeout recovery. Zero provider calls. Disposable database removed.

Full checks passed: build, lint, architecture, Prisma validation; 2,039 Jest tests / three skipped, 107 passing suites / one skipped; production audit zero vulnerabilities; governance consistency, eight governance regressions and whitespace checks. No UI change or browser QA applicability.

## Limits and next gate

This is transactionally enforced for the optional review path, not a complete live accounting system. Runtime configuration is trusted and snapshotted per operation; there is no approval-authoring workflow or independently refreshed rate service. Actual approved caps/rates/identities and test packet remain missing. Used totals are held liabilities from this ledger, not verified provider invoices or external account usage. Cancelled zero-hold operations conservatively fail review replay; no automatic reset/refund introduced.

Review the source, its ledger call sites and reproducible harness. Before more live integration, reconcile the exact staging approval/rate packet and its trusted loading source read-only; do not invent prices or add more generic fixture services. Google response-ID retention and county qualification remain unresolved. No actual provider/account change, IAM/secret change, charge, message, merge, deployment or production migration. APP-013/2B Now; 3/8 walkthrough accepted (37.5%), not whole-MVP completion.
