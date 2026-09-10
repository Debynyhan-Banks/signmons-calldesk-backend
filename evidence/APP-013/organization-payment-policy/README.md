# Approved organization payment policy and reviewed job binding — 2026-09-10

Explicitly approved prerequisite after checkpoint 395e86a: owner/admin payment-policy setup with versioned approval and a snapshot on each explicitly reviewed job. Local-only composition, fictional amounts, no production registration or provider actions. This does not finish preferred-window editing or booking.

## Behavior and files

- src/tenants/organization-payment-policy.ts defines strict fixed USD policy: serviceFeeRequired/serviceFeeCents, depositRequired/depositPolicy (none or fixed amountCents), emergencyFeePolicy:none, paymentGateMode:fail_closed, webhookValidationRequired:true. Required amounts are integer cents 1..100000000; disabled fee is null, disabled deposit is none. No percent deposits, emergency surcharge, manual waiver or dynamic pricing in this slice.
- OrganizationPaymentPolicyService/controller reuse the organization setup CAS pattern in TenantOrganization.settings.organizationPaymentPolicyV1: version 1 draft and separate approved {draft,actorId,approvedAt}; global tenant updatedAt guards saves/approvals. Separate explicit approval required; later drafts preserve approval. Malformed stored state refuses; unrelated settings preserved; update and audit are atomic. Owner/admin only, active tenant, no impersonation. GET/PUT /organization/payment-policy; POST /organization/payment-policy/approve. All unregistered outside the local verifier.
- JobPaymentPolicyService/controller: POST /job-payment-policy/apply accepts exactly jobId, expectedUpdatedAt, approvedAt, acknowledged:true. Verified owner/admin only. Shared tenant lock protects current approved policy; job lock and CAS protect the reviewed CREATED job. Human-reviewed intake, empty pricing/no existing payment terms, no payment record, Calendar history or scheduling state required. Does not touch the service window or mark contact/address verified.
- Copies canonical gate flags, fixed USD pricing and immutable approved policy/approval digest/actor/source-job-version into paymentPolicyBinding. Preserves unrelated policy and intake metadata. Audit/job update in one transaction. Exact same-actor/version/approval replay while job/terms/current approval still match returns same receipt without writes; changed approval, existing terms/activity or replacement request refuses. Existing bound jobs never automatically adopt newer approval. No replacement/repricing workflow is supplied.
- scripts/fixtures/payment-policy.js and operator-intake-review.html connect local save/approve/apply to the job opened through readiness. Explicit acknowledgment for approval and attachment; unsaved edits cannot be approved. Private memory-only state, pending exact request/retry, clear/identity-change cancellation and no caching. Unknown save acknowledgment may require reload; approval is not inferred from an uncertain outcome. No auto-approval, charging or automatic retries.

The Stripe best-practices skill informed preservation of mandatory webhook validation and no fulfillment from browser assertions. No Stripe API/SDK/keys/checkout changes were necessary; no account, entitlement, provider configuration or charge was performed. The source governs this narrow local attachment flow, not a claim that all existing runtime job creation already consumes it.

## Validation

Backend 84 suites / 1573 tests pass (19 new); three pre-existing tests skipped. Backend lint/build/architecture/Prisma, UI lint/170 tests/16-page build, four full/production dependency audits with zero findings, script syntax and diff checks pass. Governance placement/consistency passes. Existing Next lint/multiple-lockfile/PostCSS and pg concurrent-query deprecation notices remain non-blocking; no SDK/schema/migration changes.

Real local Nest/browser/PostgreSQL proof uses substituted fixture identity, not production Firebase acceptance. Parent retains 12 organization/intake groups, eight admission groups and now seven connected browser groups. New policy proof: fictional 7500-cent service fee separately saved/approved/bound; later 9500-cent draft leaves approval/job at 7500. Job/intake metadata preserved, exact binding replay writes nothing, policy and binding audit failures roll back in PostgreSQL, concurrent approval succeeds once, stale approval and superseded replay refuse, wrong role/tenant refuse. A subsequent new approval leaves the prior job unchanged. Required payment remains LOCKED, no payment record is created, no booking/send occurs. Four fictional jobs across parent phases and the entire disposable database are removed.

See payment-policy-summary.json and desktop/mobile screenshots. Screenshots precede the final service-side concurrent-approval test. Dates, tenant/company and amounts are fictional. No new process-kill proof; prior Calendar instability remains historical, with current full tests passing.

## Review/reproduce

Review PR #21 incremental after 395e86a. Inspect policy validators/services/controllers, job binding, local fixture and tests. Confirm no production module references and no edits to payment provider/gate logic. From the backend worktree:

```sh
npm run lint
npm test -- --runInBand
npm run arch:check
npm run build
npx prisma validate
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-payment-policy-proof-20260910 PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
psql -h /tmp -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'calldesk_org_%'"
```

UI: npm run lint, npm test, npm run build in ui. Run npm audit and npm audit --omit=dev in both roots. Governance: node --test scripts/execution-placement.test.mjs; node scripts/docs-consistency-check.mjs. All browser pages are ephemeral local fixtures, closed by the runner.

## Next and progress

Stop for review. Next proposed bounded section returns to the missing preferred-service-window review on the created job, using exact job version and human ownership; do not interpret a preference as availability or a booking. Contact/address verification, current-policy rollout, existing-job repricing, finalized-event messaging and production identity/provider/release acceptance remain gates.

APP-013 sole Now, Next empty, FE-014 paused. APP-013 stays 50% recorded scope coverage / 0 of 12 formally accepted; onboarding 3 of 6 (50%) local evidence / 0 accepted; pilot 0 of 12 accepted. This prerequisite is locally demonstrated, not full S2 completion or an overall engineering ETA. No merge/deploy, production migration, real records, IAM/secrets/billing/charges, sales-advisor or website-import expansion.
