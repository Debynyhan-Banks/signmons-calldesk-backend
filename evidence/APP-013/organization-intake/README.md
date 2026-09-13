# Approved organization → protected intake → operator review

Review-ready local connection after backend d7821e1/governance 62f4b78. Owner said proceed; MVP sales/advisor and website-import expansion remains excluded. No production route/module/UI registration or provider configuration changes in this slice.

## Change

`CustomerIntakeContinuationService.continueOrganization` accepts the same exact customer credential/interaction/message input as existing continue. It obtains the active tenant's approved profile under the existing shared tenant/session locks, uses deterministic approved FAQ/fallback text and persists encrypted input/reply with organization approval timestamp and SHA-256 snapshot digest. It never uses an operator token, caller-selected organization, editable draft or live model/tool. Long or multiline customer messages remain eligible for fallback; only matching normalized FAQ text produces its answer.

Turn payload type remains protected_intake_turn_v1 with strict numeric version 2 and two additional fields organizationApprovedAt/organizationDigest. Existing version-1 scripted histories remain supported; mixed histories or mode switching refuse. All version-2 turns must share the same current approved profile. The second locked write rechecks approval after the reply is prepared. Exact replay remains duplicate-free only while session/history/approval stay valid. Draft-only organization changes preserve approval; reapproval, including unchanged content under a new approval identity, refuses the old session. This is a conservative stale-state refusal, not automatic recovery or a new review SLA.

Existing submitReview persists the encrypted draft and transcript digest, which covers version-2 organization bindings. Existing operator readReview revalidates the bound current organization and adds organizationApprovedAt to its private receipt; it still never touches customer credential methods. The request payload itself remains version 1. No source facts, operator identity or organization digest is added to customer replies or ordinary audit metadata. No job, booking, consent grant or notification authority results.

## Validation

- Backend lint/build/architecture/Prisma pass; full suite 1520 passed, 3 existing skipped. Nine new unit cases cover approved-only/fallback/long messages, missing/malformed profile, caller override, approval races and legacy-mode refusal.
- Unchanged UI lint, 170 tests and 16-page build pass. Full and production audits in both roots: zero findings.
- The committed organization proof now runs seven prior setup checks plus five new organization/intake groups (12 total). Uses the real database/service, existing protected browser transport and fictional test identities/keys. Desktop/mobile browser reaches approved reply, email skip and read-only draft. Durable customer submit and token-free operator read are tested at the service boundary, not new browser buttons. No Firebase/production identity acceptance, real AI or external requests.
- Proves encryption, duplicate replay, tenant refusal, script-mode separation, draft/approved separation, changed-approval refusal and no job/provider effects. All 19 existing migrations apply only to the random disposable Unix-socket database; final cleanup removes it. Broad Calendar process-crash browser fixtures were not rerun because this slice does not change Calendar code; full backend regression and targeted real DB/browser proof ran.

## Reproduce and review

Build backend and UI, then from backend root:

```sh
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-org-intake-proof \
PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
node scripts/verify-organization-profile.mjs
```

Inspect organization-intake-summary.json and screenshots here. Inspect service guards and version-2 payload parsing, then follow: approve company answer → customer asks exact FAQ → skip optional email → review draft → service-level submit → operator read identifies approval version. Edit organization draft and confirm request still reads; approve new version and confirm old request/replay refuse without extra events. `psql -h /tmp -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'calldesk_org_%'"` must return no rows. Governance placement/consistency and both git diff --check also pass.

## Limits / next

The reused fictional browser calls its deterministic answer “scripted”; it is not a production page or semantic conversation. FAQ answers and descriptive business rules do not override routing/payment/category policy or verify customer statements. The reviewed draft is not saved by browser preview alone. Request-to-job admission, end-user submit/operator decision UI wiring, visible recovery for approval changes, production identity/key lifecycle and data retention remain open. Older code rejects version-2 turns; any eventual mixed-version rollout needs separate compatibility review. No deployment or existing production session migration occurred.

Next bounded target after review: token-free operator admission of the durable reviewed request, retaining the organization version and committing one job/consent association atomically. Then connect browser review actions to that admission; do not report the full organization-to-job walkthrough complete yet. MVP percentages unchanged: onboarding 3/6 (50%) locally demonstrated / 0/6 accepted; APP-013 50% coarse scope coverage / 0/12 accepted; pilot 0/12 accepted. O5 gains partial local evidence, not full conversational acceptance or progress credit. No overall effort percentage/ETA.

No sales/advisor playbook, website import, new package/schema/migration, live AI, Calendar/payment/dispatch/notification action, external send, real customer data, IAM/secrets/billing/charge, merge or deployment.
