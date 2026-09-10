# Reviewed preferred service window — 2026-09-10

Owner reviewed b61bb55 and approved continuing with the preferred-service-window section. Completed one local operator workflow: load the created job's readiness, record/review a customer-stated preference, save it atomically and reload readiness. No availability lookup, timestamp inference, reserved slot or booking.

## Implementation and limits

- New inactive PreferredWindowReviewService/controller, POST /preferred-window-review/save. Input exactly jobId UUID, canonical expectedUpdatedAt, preference (trimmed plain text 1–500 characters, no controls/format characters or unknown/not-provided placeholders), acknowledged:true. Verified non-impersonated owner/admin/dispatcher, active tenant, undeleted CREATED job and prior human intake review required. No caller tenant/actor/payment/booking override.
- Shared tenant lock, job lock and conditional exact-version update. Refuses any payment record, Calendar history or existing scheduling fields. Saves preferredTimeText, clears obsolete preferredWindowLabel and adds preferredWindowReview metadata; keeps pricing, payment policy/binding, intake review, status and actual appointment fields unchanged. Free text is deliberately not parsed into dates/timezone or assumed available.
- Job update and USER audit are atomic. Audit/review metadata contain version, actorId, expected/current job version, source CUSTOMER_STATED_OPERATOR_REVIEW, digest and availabilityChecked:false, not the preference text. Current same-actor/exact-input replay returns the same receipt without writes. Fresh-version corrections are permitted and audited; stale or different-actor replay refuses. Changing a job version also invalidates older exact-version commands, including prior payment-policy attachment retries; no automatic repair/repricing.
- Booking-readiness response adds preferredServiceWindow for the authorized operator. Existing missing-field assessment now sees the stored preference; no booking authority is implied. Receipt keeps availabilityChecked:false, bookingAuthorized:false, deliveryAuthorized:false.
- Local operator window-review.js provides acknowledgment, memory-only pending request, explicit exact retry, stale/error refusal, clear/identity-change invalidation and readiness reload after save. Editing resets acknowledgment. Readiness version refresh invalidates other unsaved job review bindings rather than silently rebasing them. All new controllers remain absent from production modules. Existing protected customer submission is unchanged.

## Validation and evidence

Backend lint/build/architecture/Prisma pass. 85 suites / 1598 tests pass, including 25 new cases; three pre-existing tests skipped. UI lint/170 tests/16-page static build pass. Four fresh full/production dependency audits: zero findings. Script syntax/format, diff and governance checks pass. Existing Next lint/multiple-lockfile/PostCSS and pg concurrent-query deprecation notices remain non-blocking; no dependency or migration change.

Parent verifier reruns 12 organization/intake and eight admission groups; connected browser proof now has 12 groups, including five new preference checks. Actual Chromium + local HTTP/Nest/PostgreSQL with explicit fixture identity (not production auth acceptance): initial save loses its acknowledgment after commit, exact browser retry writes once; audit injection rolls back preference/version; fresh reload removes only missing preference while payment/contact/address blockers remain; stale/foreign/role/authority requests refuse; concurrent identical fresh-version correction commits once. Policy/pricing/intake snapshots and appointment fields are unchanged. Two preference audit rows represent initial save and correction, not duplicate retries. No payment record or provider call. All four fictional jobs and the disposable database are removed.

preferred-window-summary.json and focused desktop/mobile screenshots show the reviewed local outcome. Screenshots precede the final correction; no automatic date or booking claim. Private clear removes the form state. No new process-kill or production integration proof; historical Calendar test instability remains recorded, with the current suite passing.

## Review and reproduction

Review PR #21 incremental after b61bb55: service/controller/tests, readiness projection, operator fixture and verifier hook/helper. Confirm no production module registration, no scheduling/payment mutation and preserved snapshot fields. Inspect the summary and both screenshots.

From the focused backend worktree:

```sh
npm run lint
npm test -- --runInBand
npm run arch:check
npm run build
npx prisma validate
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-preferred-window-proof-20260910 PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
psql -h /tmp -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'calldesk_org_%'"
```

Run UI lint/test/build in ui and full/omit-dev npm audits in both roots. Governance: node --test scripts/execution-placement.test.mjs and node scripts/docs-consistency-check.mjs. Proof closes its ephemeral pages and removes its database. It is not a deployed app or production identity acceptance.

## Next review and progress

Stop for review. Next priority is the contact/address verification gap: inspect existing validation/coverage evidence and define the minimum proof before either blocker can clear. Do not implement a checkbox-only claim of verification, infer availability, or activate provider calls. Payment completion, actual slot/booking, finalized confirmation, production identity and rollout remain gates. Full S2 is open.

APP-013 sole Now; Next empty; FE-014 paused. APP-013 50% recorded scope coverage / 0 of 12 accepted; onboarding 3 of 6 (50%) local evidence / 0 accepted; pilot 0 of 12 accepted. No overall engineering percentage or ETA. No merge/deploy, production migration, real data, IAM/secrets/billing/charges, sales/advisor or website-import expansion.
