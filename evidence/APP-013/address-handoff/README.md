# APP-013 saved local address review handoff — 2026-09-10

## Outcome

The explicitly selected fictional address snapshot can now accompany the existing saved customer review request. It is encrypted beside the seven-field draft, saved with the existing audit in one transaction, and displayed to authorized operators as historical local test information. Job admission is unavailable for these new snapshot-bearing requests. Existing requests without local snapshots retain their previous behavior and verification blockers.

Changed files: customer-intake-continuation.service.ts/spec.ts; customer-consent-browser-transport.ts/spec.ts; local-address.service.ts; new local-address-review-snapshot.ts/spec.ts; customer-intake-journey.js and operator-intake-review.js; verify-address-journey.mjs, verify-browser-verification.mjs and new verify-address-handoff.mjs. Board and evidence updated. No schema, package, migration, routing, production registration, external provider, real data or billing changes.

## Contract and safety

- Optional addressSelection on POST /customer-session/submit has exactly candidateId, query, revision and unit. The transport requires fixtureLoopback; the unregistered service requires an injected read-only transactional address collaborator. Missing injection refuses. The old request remains valid without the new field.
- The service holds the existing session lock, checks transcript/session, and reads the exact confirmed address selection/current catalog-area fingerprint inside the save transaction. The composed address must equal the already reviewed draft. It rechecks after writes before commit; audit or validation failure rolls everything back. No network/provider call occurs inside the transaction.
- The existing v1 review payload permits one explicit optional encryptedLocalAddress field. Decrypted data is strictly bounded and must match draft.address; it retains candidate, query, unit, address revision, local coverage and all-false authority flags. Raw address/unit or bearer are not added to the audit or public receipt. This is not a retained full policy document or real geographic proof.
- Exact replay requires the same draft and snapshot and fresh address/policy eligibility. Omitting or changing snapshot evidence cannot downgrade replay. Policy changes can refuse acknowledgment even if an earlier request committed: the browser retains fields and displays the opaque request reference with an uncertain-outcome warning, never claiming rollback or automatically resubmitting.
- Operator reads remain role/tenant restricted and credential-free. They show historical data with addressSnapshotCurrent:false and admissionAuthorized:false, including after service-area changes; no current geographic claim is made. Existing transcript/session expiry and organization checks remain. Unit remains customer-stated.
- The new snapshot-bearing review cannot enter admitReview. Its operator urgency/acknowledgment/approval controls are disabled and its warning is visible. No verification blockers are removed. The separate existing admission path and its regression proof are unchanged.
- Configuration may change after the last read; this is saved historical evidence, not continuously current authority. APP-013 owns replacing the local-only seam only after separately approved real proof/admission requirements. No new production route or activation is registered.

## Validation

- 22 new unit cases: 18 strict snapshot cases, two service composition cases and two fixture-boundary cases. Full backend: 1753 passed / 3 existing skips, 92 passing suites.
- Build, lint, architecture, Prisma validation, JavaScript syntax and diff checks passed. Full and production-only dependency audits: zero findings.
- Seven-group new browser/database proof: real encrypted save/audit rollback; exact revision/unit/candidate refusal; lost-ack and concurrent exact replay once; omitted snapshot refusal; tenant/role-isolated historical read; policy-change replay refusal without losing historical display; no job admission and mobile/desktop operator warning.
- Existing organization/admission/browser/phone/budget/address regression retained. Customer address journey now uses real continuation/draft/review services with scripted replies, not a stub transcript preview. Operator screenshot proof uses a local browser route adapter to the real role-scoped read service; it is not a production-auth or full HTTP-controller acceptance claim. Parent proof separately retains actual operator controller coverage.
- New address fixture creates no jobs and makes no live provider calls. The parent admission proof retains its separate fictional job. Disposable database removed. Desktop 1280x900 and mobile 390x844 screenshots visually reviewed; mobile has no horizontal overflow.
- Initial combined address stress/handoff proof exhausted the local 20-request peer budget. The verifier now starts a fresh local request-budget model for the separate handoff proof group; monetary holds are never reset and no production bypass is added. A concurrent test-process invocation exited 139 without test output; the isolated full rerun passed. Existing pg concurrent-query deprecation remains.
- Only backend-owned fixture JS changed; real browser QA covers it. No standalone application UI build or live-pilot acceptance claimed.

## Exact review / reproduction

Review 8a0178a..HEAD on codex/app-013-transactional-messaging, PR #21. Inspect the two address-handoff screenshots and address-handoff-summary.json here.

1. Follow the local fictional customer journey through confirmed address/unit and draft review; explicitly submit. The lost-response test retries the same request and verifies exactly one review/audit.
2. Open that request as the fictional operator: selected address/unit and historical local coverage must appear; urgency, acknowledgment and job approval must stay disabled.
3. Inspect rollback, changed-selection/policy and foreign-role/tenant tests. Confirm no schema/module/provider changes and no job writes in this address fixture.

```sh
npm run build
npm run lint
npm test -- --runInBand
npm run arch:check
npx prisma validate
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-address-handoff-proof-20260910 PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
```

Local sockets/browser permission required. The verifier creates and removes a random calldesk_org_* database. Governance gate: node scripts/docs-consistency-check.mjs.

## Handoff / progress

Stop for review. Next proposed bounded section: combine the existing approved-organization context and this address handoff in one local steel-thread proof, documenting remaining real-verification/admission gates rather than adding another provider or enabling admission. Separate approval remains required before implementation; APP-013 remains sole Now, Next empty, FE-014 paused.

APP-013 50% recorded scope / 0 of 12 formally accepted; organization onboarding 50% locally demonstrated / 0 of 6 accepted; pilot 0 of 12 accepted, not 0% built. No defensible overall engineering percentage or ETA. No merge, deployment, production migration, live sending/spending or real customer changes.
