# Section 2A — current-proof admission

2026-09-11. Started from fetched/aligned backend 37bcb15 and governance 7f76eb1. Owner accepted 1B and approved 2A with “i reviewed the evidence proceed”. Current section 3/8 demonstrated; accepted 2/8. No new baseline section, ticket promotion or production action.

## Changed files and boundary

- current-proof-admission.ts adds an inactive transaction-only source contract and consumer. Exact reviewed phone/address, current revisions, phone/address/county deadlines, US eligibility, US/OH/Cuyahoga 39035 IN_AREA, current organization version and actual approved tenant payment policy must agree. Source evidence is never accepted from an HTTP caller. No external calls occur inside the admission transaction.
- customer-intake-continuation.service.ts consumes it before existing atomic job/address/link/consent/audit creation. Minimal references, coverage policy, timestamps and approved payment provenance are stored under intakeAdmission.currentProof. This is not a charge-policy application or permission to pay/book/send. Existing real-verification flags remain NOT_VERIFIED; fixtureOnly=true and realVerificationAccepted=false.
- customer-consent-session-lock.ts permits authenticated existing-receipt lookup after cleanup. New admission must repeat the default active-session check; the receipt path still checks exact actor/decision/digest/organization and original review deadline. It neither renews proof nor creates a replacement job.
- Existing operator-intake-review.js can allow review of a historical local address snapshot only when the server has the optional fixture source. Approval still resolves current proof; the snapshot/browser flag is never authority. Default review-only behavior remains unchanged without the source.
- current-proof-admission.spec.ts adds 18 tests. verify-current-proof-admission.mjs, called by the existing parent verifier, reuses existing customer/operator HTML, protected browser transport and CustomerIntakeReviewController. No separate form or production route was added.

## Identity and evidence limits

The customer uses the existing signed session transport with fictional server integration context. The operator uses a separate browser context and explicit fixture-only auth-guard override; the operator service throws if it attempts to access customer credentials. The proof source is deliberately injected test data, keyed to the submitted request; it is not a received OTP or real address/county observation. A fictional approved payment policy is seeded only in the disposable tenant. Real RequestAuthGuard/account/source integration is not certified by this fixture.

Human job review remains separate from automated verification. Consent binding reuses the existing transaction; missing evidence stays NOT_RECORDED and never becomes sending permission. Parent regression separately proves granted/declined binding and rollback. No production registration, real participant/provider call, county qualification, charge, calendar action, sending, schema migration or deployment.

## Validation observed

- Backend build, lint, architecture: passed. Full suite: 99 suites / 1,887 tests passed, three existing skipped tests. One earlier full run exited 139; unchanged full rerun passed. That intermittent Node/toolchain risk is not declared resolved.
- UI: 170 tests, lint and build passed. Prisma validate passed; schema unchanged.
- Four npm audits (backend/UI, full/production) each reported zero findings. Existing pg concurrent-query deprecation and Next workspace-root/lint-tool warnings remain.
- Disposable PostgreSQL plus real mobile/desktop browser: seven new proof groups passed, including ten invalid/mismatched source cases, tenant/role refusal, real audit rollback, lost acknowledgment and concurrent receipt replay after cleanup without re-consuming proof. Exactly one fictional job and one admission audit remained.
- Full parent organization/intake/address/freshness/cleanup/operator/readiness/payment-policy/window regression passed. Actual 390px and 1280px screenshots inspected; no horizontal overflow or page errors.
- Independent calldesk_org_ database inventory returned []; fixtures were dropped. Original dirty saved backend checkout was preserved.

The initial new browser test checked a pending retry before its failed request had finished. It was corrected to await the enabled retry before removing the injected audit fault. No product behavior was weakened. Final output: /private/tmp/signmons-2a-verified-20260911; summary.json in this evidence folder reproduces the sanitized section output. Screenshots are ephemeral local evidence, not production records.

## Reproduce and review

From the focused backend checkout, with disposable local PostgreSQL available:

```sh
npm run build
npm run lint
npm run arch:check
npm test -- --runInBand
npx prisma validate
npm --prefix ui test
npm --prefix ui run lint
npm --prefix ui run build
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-2a-review PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
```

The parent creates/migrates/drops only a random calldesk_org_ database on the local Unix socket. Review current-proof-admission-summary.json and current-proof-admission-mobile.png/current-proof-admission-desktop.png in the output directory. Inspect the fail-closed source consumer, atomic currentProof snapshot and receipt-only/default-lock split. Verify the resulting job is CREATED, not booked or real-verified, and that consent does not imply sending.

After accepting 2A, next is 2B's controlled-verification entry checklist: qualified county source/terms, named legitimate participant and tenant/accounts, approved notices, current rates, explicit caps and narrowly approved calls/spend. No such live action is inferred from accepting this section. APP-013 scope index stays 50%, accepted 0/12; onboarding local 50%, accepted 0/6; pilot accepted 0/12. The 2/8 section fraction is acceptance progress, not an overall engineering completion estimate or calendar ETA.
