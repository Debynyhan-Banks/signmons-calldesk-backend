# Local job booking-readiness preview — 2026-09-10

Owner approved the proposed bounded S2 section after reviewing the local browser admission checkpoint f317103. This extends that same journey: after one CREATED job, the operator opens a read-only readiness snapshot and sees why booking and confirmation remain unavailable. No real booking, payment, sending or production activation.

## Implementation

- New inactive BookingReadinessPreviewService and guarded POST /booking-readiness/preview controller; absent from production modules. Exact jobId-only input, verified non-impersonated owner/admin/dispatcher, active tenant and tenant-correct undeleted job/customer relations. Other job states refuse rather than claiming booking truth.
- Repeatable-read transaction sets PostgreSQL READ ONLY. Reuses IntakeReadinessService assessment without transcript reads/audits and evaluatePaymentGate without changing payment policy or integration code. Returns only job/version/status, missing-field and review reason codes, payment diagnostic and confirmation refusal; no customer contact/address/transcript/credentials.
- Both depositRequired and serviceFeeRequired must be explicit booleans before the diagnostic reports a known payment policy. Intake admission currently omits these flags: UNKNOWN is not PAYMENT_NOT_REQUIRED. Required unpaid/pending/failed/refunded/cancelled state stays blocked. Even a recorded payment success never authorizes booking here.
- Human review, contact/address verification and unfinished Calendar operations remain visible blockers. No blockers means REQUIRES_BOOKING_VALIDATION, never ready-to-book authority. This snapshot is not a current tenant-policy approval or availability/pricing/service-area check.
- Operator fixture opens the newly created job without copying a customer bearer. Readable labels, private memory-only state, bounded fetch, no caching and clear-on-error/identity-change/session-clear. Reload loses the job reference; a general job/history workspace is not added here.
- Confirmation preview is explicitly UNAVAILABLE / APPOINTMENT_NOT_FINALIZED. No fabricated date, management link or confirmation message. Existing finalized-event recipient/consent/expiry eligibility service is not called on an unbooked job and is not bypassed. Real content preview and positive delivery eligibility remain later S2 work.

## Validation

Backend lint/build/architecture/Prisma pass. 83 suites / 1554 tests pass, including 12 new cases; three pre-existing tests skipped. UI lint / 170 tests / 16-page static build pass. Four fresh full/production npm audits report zero findings. Script syntax, formatting, diff and governance checks pass.

Parent local proof reruns 12 organization/intake groups and eight atomic admission groups; connected browser proof now has six groups. New readiness group opens the actual admitted fictional job, confirms missing window/policy/verification reasons, asserts job and audit unchanged after the read, rejects foreign tenant/role/invalid identity/authority override, changes only disposable fixture policy to demonstrate unpaid-required refusal, then restores it. No extra job is created by this read. All four fictional jobs across proof phases are removed with the disposable database. Screenshots show desktop/mobile; summary contains only fictional IDs and diagnostic text. Explicit fixture identities are not production auth acceptance. No process-kill test or provider interaction.

Non-blocking existing Next lint/multiple-lockfile/PostCSS warnings remain; a pg concurrent-query deprecation warning appeared in one proof run. No dependency or Calendar changes. Prior intermittent Calendar HTTP failure remains documented historically; this run's full suite passed.

## Review and reproduce

Review incremental changes after f317103 in PR #21, especially production-module absence, read-only transaction, payment UNKNOWN handling and confirmation refusal. Inspect booking-readiness-summary.json and both screenshots.

From the focused backend worktree:

```sh
npm run lint
npm test -- --runInBand
npm run arch:check
npm run build
npx prisma validate
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-booking-readiness-proof-20260910 PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
psql -h /tmp -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'calldesk_org_%'"
```

Run UI lint/test/build in ui; run npm audit and npm audit --omit=dev in each root. Governance: node --test scripts/execution-placement.test.mjs and node scripts/docs-consistency-check.mjs. Runner closes ephemeral browser pages and removes its database; not a deployed UI.

## Checkpoint and next decision

This completes the bounded local readiness/refusal view, not S2 booking or notification acceptance. Next proposed outcome: resolve missing preferred window and review the current organization payment policy through an explicit authorized job-review workflow, then demonstrate the local booking decision. Reconcile existing mutation contracts before implementation; do not make these diagnostic flags into a new policy authority. Contact/address verification and actual availability remain gates. No automatic ticket promotion, integration approval or release.

APP-013 stays sole Now, Next empty, marketing paused. Progress unchanged: APP-013 50% scope coverage / 0 of 12 accepted; onboarding 3 of 6 (50%) local evidence / 0 accepted; pilot 0 of 12 accepted. No overall engineering percentage or ETA. No schema/migration/package change, merge/deploy, real records, IAM/secrets/billing/charges; advisory sales and website import remain outside MVP.
