# APP-013 combined organization/address/review proof — 2026-09-10

## Outcome

One fictional tenant now exercises the existing owner-approved company profile, approved FAQ answer, selected address/unit, read-only draft, encrypted saved review and operator display in the same local journey. The operator sees the exact organization approval timestamp and historical local coverage together. An unapproved company draft edit preserves the review; approving that changed profile makes the old review unavailable. The snapshot still cannot authorize job admission.

This section changes proof scripts only: verify-browser-verification.mjs, verify-address-journey.mjs and verify-address-handoff.mjs, plus board/evidence. No production application code, API contract, schema, dependency, provider or admission behavior changed. Organization context uses the real OrganizationProfileService save/approve calls and continueOrganization; the customer answer comes from the deterministic approved FAQ path, not a scripted reply collaborator or live AI.

## Evidence and validation

- Seven combined checks are in organization-address-thread-summary.json. The real PostgreSQL/session/organization/continuation/address/review services are exercised together, including exact organization version in the operator response, draft-versus-approval distinction and stale review refusal.
- Existing phone/budget mocks, address corrections, rollback, lost acknowledgment and exact replay, tenant/role checks and prior organization/operator-admission regression remain covered. No new jobs in the combined address fixture; the parent retains its separate fictional admission fixture. Zero live provider calls.
- Full backend: 1753 passed, three existing skips, 92 passing suites. Build, lint, architecture, Prisma validation, JavaScript syntax and diff checks passed. Full and production-only dependency audits: zero findings.
- Desktop 1280x900 and mobile 390x844 operator screenshots visually reviewed; approval, urgency and acknowledgment controls remain disabled. Mobile overflow check passed. Operator browser uses the existing local route adapter calling the real role-scoped read service, not production authentication. Parent actual-controller proof remains separate.
- Disposable calldesk_org_* database removed. Existing pg concurrent-query deprecation remains. Only backend-owned proof scripts changed; no standalone UI build or real-phone/pilot acceptance claimed.

## Remaining gates (not implemented or waived)

| Gate | Current verified boundary | What is still required |
| --- | --- | --- |
| Phone access | LocalVerificationBrowserService keeps phoneAccessAuthorized false; Verify SDK calls are mocked | Approved real rate/account/service and legal-notice binding, cost reconciliation/recovery, shared abuse limits and explicitly capped testing; successful access proof must bind to current session/phone |
| Address/coverage | LocalAddressService uses an injected fictional catalog; unit is customer-stated | Approved real source and validation semantics, cost/retention rules and current tenant service-area evidence; suggestions do not prove location or occupancy |
| Review-to-admission | admitReview refuses records with localAddress; readiness retains CONTACT_NOT_VERIFIED and ADDRESS_NOT_VERIFIED | Explicit real-proof consumption contract, freshness/revocation/error behavior and negative tests before removing any blocker |
| Pilot/release | This proof is local and non-authoritative | Remaining owner/live acceptance, release review and explicit authorization; no merge/deploy inferred |

The approved $50 per-organization monthly phone ceiling is an internal safeguard, not permission to spend; it does not authorize address-provider costs. Existing calendar/payment/messaging operational acceptance is not closed by this proof. No automatic sending, booking, payment or dispatch is enabled.

## Exact review / reproduction

Review 588c9f7..HEAD on codex/app-013-transactional-messaging, PR #21. Inspect the combined summary and two screenshots here.

1. Check that the fictional owner saves and separately approves the company facts through OrganizationProfileService.
2. Follow the browser question "Do you repair cooling?" to its approved answer, then selected address/unit and saved review. The operator version must equal the original approved company version; all admission controls remain disabled.
3. Inspect assertions that an unapproved edit preserves review and a new approval refuses the old review. No production source file should appear in this section's diff.

```sh
npm run build
npm run lint
npm test -- --runInBand
npm run arch:check
npx prisma validate
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-organization-address-proof-20260910 PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
```

Local socket/browser permission required; the verifier creates and removes a random disposable database. Governance: node scripts/docs-consistency-check.mjs.

## Next / progress

Stop for review. Next proposed bounded work is a review-only real-verification-to-admission readiness contract and approval checklist based on the gates above. Do not add another local fixture feature or enable a provider/admission path automatically. Any provider selection, live test, spending, configuration or implementation needs its own explicit approved scope.

APP-013 sole Now, Next empty, FE-014 paused. APP-013 50% recorded scope / 0 of 12 accepted; onboarding 50% locally demonstrated / 0 of 6 accepted; pilot 0 of 12 accepted, not 0% built. No defensible overall engineering completion percentage or ETA. No merge, deployment, production migration, real data, IAM/secrets, billing or live spending/sending.
