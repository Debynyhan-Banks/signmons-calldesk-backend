# APP-013 local selected-address draft connection — 2026-09-10

## Outcome and boundary

The optional local address journey now copies the server-selected fictional address and customer-stated unit into the existing seven-field read-only draft preview. The response includes a clearly labeled local coverage snapshot. It never grants real address, booking or sending authority. UNKNOWN and OUT_OF_AREA remain visible, not converted into success. Edit draft clears the displayed preview and requires another customer review. Local address mode hides and guards operator-review submission; the existing non-address admission workflow is unchanged.

Changed source: local-address.service.ts; customer-consent-browser-transport.ts and its spec; customer-intake-journey.html/js; verify-address-journey.mjs and verify-browser-verification.mjs. Backend board and this evidence accompany the section. No schema, package, migration, routing, production registration, provider, billing, customer data, master address or job changes.

## Contract / consistency

Optional POST /customer-session/draft field addressSelection has exactly candidateId, query, revision and unit. It requires explicit fixtureLoopback plus an injected address port. The original three-field draft request remains backward-compatible. Existing origin, session/tenant, request budget and body defenses remain.

LocalAddressService adds read-only action review to its existing eight-field request. It requires a saved confirmed selection, exact active session, revision, candidate, query and unit, plus the current complete catalog/service-area fingerprint. No mutation or audit is made by review. A request cannot confirm an unconfirmed suggestion by setting confirmed:true.

The boundary checks this receipt, obtains the candidate text from the server catalog (not caller draft.address), joins the unit using comma-space, and validates the existing 200-character address limit. It previews the resulting seven fields, then rechecks the selection and policy before releasing the response. Changed or absent evidence refuses; only fixed errors escape. Both address reads use the existing shared session lock. This is a read-only snapshot across separate transactions, NOT a persisted or continuously current geographic proof, and not atomic job admission. Configuration may change after the final read; any future consumer must revalidate again. APP-013 owns removal of this fixture-only projection when a separately approved application proof/admission contract replaces it.

## Evidence

- Eight new transport cases: canonical copy; UNKNOWN; OUT_OF_AREA; stale evidence; change during preview; authority-bearing receipt; unknown selection field; missing fixture binding.
- Full backend: 1731 passed, 3 existing skips, 91 passing suites. Build, lint, architecture, Prisma validation, JavaScript syntax and git diff checks passed. Full and production-only npm audits: zero findings.
- Eleven-group address browser/database summary attached. New checks demonstrate address/unit in draft, unchanged stored conversation, mobile/desktop review, hidden submission, stale-policy refusal, and wrong revision/query/unit/candidate/acknowledgment/forged-session refusal. Existing address concurrency/rollback/privacy and parent organization/admission/browser/phone/budget regression retained.
- New address browser proof uses real session, address service, transport and disposable PostgreSQL with scripted transcript continuation/preview. It does not claim a real AI/provider transcript. Parent organization proof still exercises the real continuation draft implementation separately. Zero live provider calls; no address/job creation in the address fixture. Existing parent fictional admission record is separate.
- Final mobile viewport is explicitly 390x844 with no horizontal overflow; desktop 1280x900. Screenshots visually inspected. Initial ES target compatibility/test lint issue and inherited screenshot viewport were corrected before final gates.
- Disposable database cleaned up. Existing pg concurrent-query deprecation warning remains. Standalone application UI build/tests not rerun: only backend-owned HTML/JS fixtures changed and received real browser QA.

## Exact review and reproduction

Review c5e4f6d..HEAD on codex/app-013-transactional-messaging, PR #21. Inspect address-draft-mobile.png, address-draft-desktop.png and address-journey-summary.json here.

1. In the local proof, find Fictional, select 10 Fictional Lane, enter Unit A and confirm. Review the draft: address must be 10 Fictional Lane, Unit A; coverage is a test snapshot and submit is unavailable.
2. Edit draft; alter unit/address and reconfirm before reviewing again. Changing service-area configuration between confirmation and preview must refuse, retaining fields.
3. Verify UNKNOWN/OUT_OF_AREA never become booking authority. Check the diff contains no changes to admission, production routing, modules or schema.

```sh
npm run build
npm run lint
npm test -- --runInBand
npm run arch:check
npx prisma validate
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-address-draft-proof-20260910 PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
```

The verifier requires local socket/browser permission, creates a random calldesk_org_* database and removes it. No provider credentials required. Governance: node scripts/docs-consistency-check.mjs.

## Handoff / progress

Stop for review. Next proposed bounded connection: retain this explicitly non-authoritative local snapshot in the existing saved operator-review handoff, with fresh revision/policy checks and without clearing verification blockers or changing job admission. This is a proposal, not implementation or release authorization. Real address provider choice, validation semantics, cost/retention, phone reconciliation and activation remain separate gates.

APP-013 sole Now; Next empty; FE-014 paused. APP-013 50% recorded scope coverage / 0 of 12 formally accepted. Organization onboarding 50% locally demonstrated / 0 of 6 accepted. Pilot 0 of 12 accepted, not 0% built. No defensible overall engineering completion percentage or ETA. No merge, deployment, live sending/spending or production action.
