# Token-free operator request admission — review-ready

Owner approved the next organization-to-job connection with “proceed”. Starting backend dcf5683 / governance cf2fec4 were fetched and aligned; existing focused feature branches only. This is one local backend admission slice, not a completed production or browser steel thread.

## Behavior and files

`src/communications/customer-intake-continuation.service.ts` adds unregistered admitReview. Exact input is requestId, expectedOrganizationApprovedAt and review {urgency,reasonCode:OPERATOR_REVIEWED_INTAKE,acknowledgeCustomerStatements:true}. Only verified non-impersonated owner/admin/dispatcher context supplies tenant and actor. The method never verifies, issues, reconstructs or reads a customer credential. The saved encrypted customer draft supplies facts; caller token/draft/tenant overrides refuse.

Under the existing session/tenant locks, reread the exact unexpired durable review, validate current organization approval and bound transcript, require the reviewed tenant service category and reuse the existing admission persistence. Customer/address, CREATED job, CREATED_FROM link, optional historical consent association, USER audit and conversation COMPLETED/JOB_CREATED commit together. Job policy records requestId and organization approval timestamp/digest alongside the human decision. Request event remains immutable; job policy/audit are the durable outcome association, not a new mutable request-status table or FK.

Receipt includes requestId, state:ADMITTED, jobId, organizationApprovedAt, humanReviewed:true and bookingAuthorized:false/deliveryAuthorized:false. Exact same-actor/decision replay before the original deadline and with unchanged approval returns the existing still-CREATED job only if its recorded decision/binding matches; no duplicate write. Changed urgency, actor, organization, expired/deleted/invalid scope or advanced job refuses. Existing readReview is for pending reviews and still refuses a closed conversation; the exact admission retry is the bounded acknowledgment-loss recovery, not a general request-status lookup.

The legacy inactive admitDraft path calls the extracted persistAdmission helper and retains its customer-credential checks and receipt. No route/module/UI registration, schema, migration, dependency or provider change. Source diff includes moving existing persistence, not rebuilding it.

## Validation

- 18 new unit cases; backend 1538 tests pass with 3 existing skips. Covers approved roles, no credential access, strict input, stale org/transcript, legacy refusal, exact replay, historical consent states, expiry and final deadline recheck.
- Backend lint/build/architecture/Prisma pass. Unchanged UI lint/170 tests/16-page build pass. Four backend/UI full/production audits: zero findings. A formatting-only lint failure was corrected before the passing gates.
- New `scripts/verify-operator-intake-admission.mjs`, invoked by existing `verify-organization-profile.mjs`, adds eight disposable PostgreSQL check groups. Concurrency/restart-style exact replay, real consent-binding and audit rollback, closed-session behavior, tenant/role/input refusal, expired requests, changed approval and privacy are proven with zero operator credential accesses. Three fictional jobs cover no consent evidence, declined and granted history; all are deleted with the disposable database, not real customer work.
- Prior 12 organization/intake database/browser groups rerun first, including desktop/mobile. No new browser admission controls exist; new admission proof is service/database level. Fixture identity is not production Firebase acceptance. Prior phase summary's jobCount:0 describes its pre-admission snapshot; operator-admission-summary.json records the three later fictional jobs.

## Repeat and owner review

Build backend and UI, then run from backend root:

```sh
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-operator-admission-proof \
PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
node scripts/verify-organization-profile.mjs
```

Script accepts only a generated calldesk_org_<12 hex> Unix-socket database; applies 19 existing migrations and drops it in finally. Verify cleanup with `psql -h /tmp -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'calldesk_org_%'"` (no rows). Governance placement/consistency and both git diff --check pass.

Review admitReview and extracted persistAdmission; inspect policy/audit binding and no credential calls. Confirm simultaneous exact approvals return one job, changed decisions refuse, binding/audit failures leave pending request and no partial job/address/link, and GRANTED/DECLINED are historical BOUND only. Review operator-admission-summary.json for the eight groups. No process-kill case was added; transaction failure and service reinstantiation were tested. No unrelated Calendar browser/crash rerun is claimed.

## Remaining / percentages

Next after review: connect customer submit and operator decision controls to this path in the local protected walkthrough. Do not claim the complete browser organization-to-job demonstration until those actions and failure states are exercised. Expiry/approval-change recovery, status lookup after deadline/advanced job, production identity/key/retention lifecycle and old-reader rollout remain review gates. Customer contacts/addresses are customer-stated and unverified; existing placeholder address coordinates remain inherited local behavior, not geocoding. No preferred appointment window, payment/availability evaluation, booking, dispatch, notification or sending is inferred from CREATED.

Percentages unchanged: onboarding 50% local evidence (3/6), 0% formal acceptance; APP-013 50% coarse scope coverage, 0/12 acceptance; pilot 0/12 acceptance. This materially closes the backend request-to-job gap, not the remaining user-facing or messaging acceptance criteria. No overall engineering estimate/ETA. Sales/advisor and website-import scope remains deferred. No merge/deploy, production migration, real data, provider/IAM/secrets/billing or charges.
