# APP-013 P2 policy-bound capture integration

Review-ready bounded implementation, 2026-09-12, following owner review of backend 64942c0 / governance b90f0a6. This completes the inactive policy/recipient/session/suppression evidence bridge, not live capture, complete P2 activation readiness or controlled SMS receipt.

## Changed files and behavior

- src/communications/policy-bound-sms-capture.ts: new inactive application seam; no controller, DI registration or live-mode option. Reuses existing session credentials, exact five-field DTO, customer/session lock, encryption, registry reader and shared SMS recipient lock/hash.
- prisma/schema.prisma and prisma/migrations/20260912180000_sms_policy_capture/migration.sql: SmsPolicyCapture with same-tenant conversation/policy/audit FKs, immutable encrypted snapshot, original deadline/receipt and DRY_RUN-only database constraint. Captured receipt cannot be rewritten. No fixture import or grant relation.
- src/communications/policy-bound-sms-capture.spec.ts: ten early-boundary regressions.
- scripts/verify-policy-bound-sms-capture.mjs and existing disposable runner: nine database integration check groups using fictional policy/customer records and actual existing consent/delivery services.
- EXECUTION_BOARD.md and this evidence directory: scope, proof and remaining gates.

PROMPT reads the exact reviewed registry disclosure/public URLs and binds full content/version/head revision, credential instance, customer identity/update time, phone HMAC/key-version label and consent row identity/status/revision into encrypted provenance. A missing consent row binds revision 0. New capture and audit commit together; exact retry returns the original timestamp without another audit. Skip grants/revokes nothing. Recipient lock precedes session/customer and policy locks, matching existing STOP writers. Current source checks apply to receipt replay too; STOP/START change-back, customer changes and policy replacement do not revive old prompts. Post-write policy authority/time checks roll back on revoked publication proof or expiry.

Session credentials prove possession of this customer session, **not phone ownership, identity, OTP completion, booking/payment or SMS authority**. The test policy is explicitly fictional. A boolean, legacy consent record or fixture record alone cannot satisfy this new evidence contract. The existing legacy live consent pathway is not redesigned or disabled by this section.

## Validation

- Build, lint, architecture, Prisma schema validation and whitespace checks passed.
- Full Jest: 104 suites / 1,955 tests passed, one suite / three existing tests skipped.
- Production dependency audit: zero vulnerabilities.
- Disposable local PostgreSQL: 20 prior durable/registry/browser regression groups, seven prior suppression groups and nine new capture groups passed. Both runs in this section passed (initial eight-group proof, expanded final nine-group proof). Each database was removed.
- New proof: two captured records matched two audits; zero final opted-in records/customer grants for its tenant, zero queue/delivery events/provider calls/production writes. Prior suppression regression separately exercises fictional legacy opt-in/STOP rows; these are not real customer data.
- New groups cover exact/concurrent replay, uncaptured skip, unknown commit/reconstruction, rollback, missing publication authority, session capacity, tenant/role/token/hash-version isolation, immutable/FK/live-mode constraints, STOP overlap, STOP/START revision change-back, recipient/session/policy changes, and actual policy expiry/revoked attestation during writes. Capacity exhaustion uses a count double; other listed database behavior uses the disposable PostgreSQL database. Same-secret process reconstruction is proven; production key rotation/retention is not.
- Existing intake browser regression at 390px/1280px passed keyboard choice, no overflow, lost-response retry, skip and no-text preview. Mobile saved and desktop prompt screenshots inspected. These screenshots show the **unchanged fixture intake**, not this new inactive service wired into a browser. New registry projection is exercised directly by the database harness; no production/UI integration is claimed.

summary.json is the initial fixture regression snapshot. suppression/summary.json describes the subsequent legacy suppression phase. policy-capture/summary.json is the new integration proof; do not conflate their row counts.

## Exact review / reproduction

1. Inspect the service lock order, immutable source comparison, final registry/deadline recheck and lack of live consent/customer/queue writes.
2. Inspect the migration's DRY_RUN constraint, composite foreign keys and immutable receipt; confirm policy-capture/summary.json has two captures/two audits and zero providers/grants.
3. Run npm run -s build, npm test -- --runInBand, npm run -s lint, npm run -s arch:check, npx prisma validate, npm audit --omit=dev --audit-level=high and git diff --check.
4. Run the local proof below with local Unix-socket PostgreSQL. It creates/drops only its own randomized database, never using production DATABASE_URL:

```sh
PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs SMS_INTAKE_EVIDENCE_DIR=/private/tmp/signmons-app013-messaging.R4Ep40/evidence/APP-013/policy-bound-sms-capture node scripts/verify-durable-fixture-sms-consent.mjs
```

## Remaining and stop point

The inactive bridge is implemented; do not reopen the registry or rewrite fixture storage. Next proposed bounded P2 implementation: stable authenticated provider-event replay identity and STOP/START retry handling, so delayed duplicate START cannot silently undo later suppression. Do not infer chronological ordering from arrival time or duplicate audit suppression. Capture/sending stay disabled throughout that work.

Before live capture: qualify real publication evidence, key lifecycle, retention/deletion (including consent row deletion/recreation), approved production evidence mode, consent grant relation and protected transport/UI composition. Before sending: separate sender/recipient/provider/release and bounded-spend approvals, plus actual controlled receipt. DRY_RUN rows must never be promoted by a flag change. New service is unregistered; no production migration, merge, deploy, public publication, provider/DNS/IAM/secret/billing changes or real customer actions occurred.

Governed-checkpoint guidance kept work isolated on the current feature branches and stopped at review. Saved checkout user changes preserved. APP-013 sole Now, current workflow 2B. Fixed steel-thread acceptance remains 3/8 (37.5% of milestones), not an overall MVP engineering percentage/ETA. Five milestone acceptances still remain.
