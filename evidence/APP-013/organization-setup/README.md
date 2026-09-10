# Organization setup — review-ready steel-thread slice

Owner approved the organization-to-job delivery target. This bounded S0 implementation provides a real owner/admin page and controller/service for draft save/reopen, saved-version approval and deterministic approved-answer preview. It is not the full steel thread, live AI answering or job creation. Governance explicitly assigns this dependency to APP-013; no ticket transition.

## Implementation

- `src/tenants/organization-profile.ts`: exact bounded facts/FAQ/voice validation; timezone validation; distinct questions; approved snapshot parsing; exact-match preview and explicit no-action receipt.
- `src/tenants/organization-profile.service.ts`: authenticated non-impersonated owner/admin tenant context; active tenant lookup; compare-and-swap timestamp; preserve unrelated JSON settings; atomic draft/approval plus privacy-safe audit. Editing drafts preserves the last approved copy. Malformed existing profile refuses rather than overwrites.
- `src/tenants/organization-profile.controller.ts` and `tenants.module.ts`: GET/PUT `/organization/profile`, POST `/organization/profile/approve`, POST `/organization/profile/preview`, existing request-auth/tenant guards, throttling and private/no-store success/error responses. Registered in source, not deployed. Existing tenant creation remains unchanged.
- `ui/src/app/app/organization/page.tsx`: owner token held only in memory; company facts, contact fallback, greeting/tone, 1–10 FAQ/source rows, save/review/approval/preview. Dirty form cannot approve; stale/uncertain response requires reload. Clear/unmount invalidates old requests. Root sandbox links to setup.
- No schema, migration, package or lockfile change; canonical routing/payment/booking fields and tenant timezone are not updated. Profile timezone and rules text are descriptive only and require manual consistency review.

## Validation and repeat commands

From backend root: `npm run -s lint`, `npm test -- --runInBand`, `npm run -s arch:check`, `npm run -s build`, `npx prisma validate`. Backend: 1511 passed, 3 pre-existing skipped; 19 new unit cases. From ui: `npm run -s lint`, `npm test`, `npm run -s build`: 170 passed, 16 static pages. Full and omit-dev audits in both roots report zero findings. Initial lint/build compatibility errors were corrected before passing gates.

After both builds, run the committed proof using explicitly local disposable infrastructure:

```sh
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-org-proof \
PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
node scripts/verify-organization-profile.mjs
```

The proof verifies Unix-socket PostgreSQL, creates only `calldesk_org_<12 hex>` database, applies the existing 19 migrations and drops its database in finally. It uses the real controller/service with an explicitly substituted fictional identity guard, not Firebase or production authentication acceptance. Browser API requests are redirected only to the local fixture. It proves real rollback, concurrency, saved/approved separation, role/tenant refusal, desktop/mobile save/approve/FAQ/fallback, stale-save reload, cleared state and zero job/provider effects. Summary and screenshots are recorded here. Initial fixture omitted the required timezone; corrected fixture passed and the failed database was removed.

Check cleanup with `psql -h /tmp -d postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'calldesk_org_%'"`. Expected no rows. Governance: `node --test scripts/execution-placement.test.mjs` and `node scripts/docs-consistency-check.mjs`; both repositories `git diff --check`.

## Exact owner review

1. Review the new page/API and inspect the screenshots. Use only a separately authorized local test identity/tenant, never a production token in a fixture.
2. Load company; enter facts and a sourced FAQ; save/reopen; acknowledge and approve the saved version.
3. Preview that exact question, then an unknown question. Confirm automatic-assistant identity, approved wording, human contact fallback and no claim a callback was created.
4. Edit/save a new greeting without approving: the previous approved greeting must remain in preview. Concurrent/stale save must require reload.
5. Review the remaining boundary before any connection to customer intake or runtime answering.

## Remaining work and percentages

S0 is partially demonstrated, not accepted. O1 (local draft access/save), O3 (FAQ/voice persistence/fallback), O4 (version approval) have local evidence: **3/6 = 50% locally demonstrated onboarding outcomes**, a newly explicit evidence count, not effort or sign-off. O2 canonical-policy consistency automation, O5 grounded real conversation and O6 full onboarding/access integration acceptance remain incomplete. All six formal checkboxes remain open: **0/6 = 0% accepted**. APP-013 retains **50% historical scope coverage / 0% formal acceptance**; full pilot **0/12 = 0% accepted**. No overall engineering percentage or ETA.

Next proposed within the approved organization-to-job target: connect an approved organization snapshot to the protected customer intake/operator review journey, with exact revision/tenant authority and human handoff. Token-free request-to-job admission is still unfinished; do not claim the walkthrough creates a job today. Phone/SMS, provider delivery, approved-data retention/withdrawal lifecycle, polished login and automatic policy conflict checks remain future reviewed work. Exact FAQ matching is not semantic AI; arbitrary FAQ text is treated as inert data, not executed, but content correctness/safety still requires owner review. No historical version archive/revocation workflow is supplied. Live tenant runtime continues to use its previous configuration; this feature does not replace it.

No merge/deploy, production migration, provider configuration, paid model calls, real customer data, IAM/secrets/billing or charges. Existing Next lint/workspace-root deprecation warnings remain. The broad Calendar/crash browser suite was not rerun: no Calendar/message code changed; full backend regression plus targeted real-database/browser evidence passed.
