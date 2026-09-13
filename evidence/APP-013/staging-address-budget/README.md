# Staging address budget policy gate — 2026-09-12

Owner approved the independent budget-gate section while response-ID retention clarification and county qualification remain unresolved. No Google case submission or response is asserted.

## Scope

New staging-address-budget-policy.ts is a pure inactive pre-reservation validator, not a live budget adapter. It requires a complete STAGING_REVIEW_ONLY packet, an independently approved canonical digest, matching current server account/project/service/runtime/tenant/session identities, USD paid-liability ceiling, rate version and validity, session expiry, enabled approval and account/tenant/session caps and usage totals.

No default allowance, actual account rate, free-tier credit or approval is configured. Tests use fictional identifiers and microscopic synthetic limits. Fixture/live/production modes, extra packet fields, mismatched bindings, stale windows, invalid integers, altered packets and insufficient caps refuse. Subtraction avoids unsafe sum overflow. Usage must include consumption plus all unresolved holds across periods.

POLICY_READY is not a reservation or spending authority: all dispatch/admission/delivery flags remain false. The digest is content identity, not a signature; the caller must obtain it from a trusted approval registry, never compute it from a browser packet and call that approval.

## Validation and review

- Build, lint, architecture and Prisma validation passed.
- Full Jest: 2,039 passed, three skipped; 107 passing suites, one skipped. 38 new policy tests.
- Production dependency audit: zero vulnerabilities.
- Whitespace and cross-repository governance consistency passed; eight governance regressions passed.
- No UI, schema, dependency or database change; browser QA and a new database harness are not applicable to this pure unregistered validator.

Review the source and spec; reproduce with npm test -- --runInBand src/communications/staging-address-budget-policy.spec.ts. Check exact cap boundaries, disabled/missing authority, wrong identities, changed digest/rates, expiry and invalid/overflow values. Verify no application registration or provider imports were added.

## Remaining boundary

This completes policy validation only, not the whole live budget gate. Next bounded implementation: trusted current approval/rate/usage loading and policy validation inside the existing atomic reservation lock, with revocation/concurrency/replay proof and no provider activation. Do not rename or promote fixture records. A real approved packet, separate address caps, account-specific rates and explicit live test/release permission remain missing. Do not represent caller-supplied totals as enforced accounting.

Google response-ID retention and county-source qualification remain separate blockers. No merge, deployment, credentials, IAM, billing, provider configuration/call, external message or customer data action. APP-013/2B stays Now; 3/8 walkthrough milestones accepted (37.5%), not whole-MVP completion; no new milestone.
