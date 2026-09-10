# APP-013 local address / service-area journey — 2026-09-10

## Outcome

Implemented the approved local selection/confirmation/coverage section. Existing customer HTML/JS optionally displays a fictional address catalog, unit field, explicit candidate confirmation, separate geographic result, refresh and clear. The selected candidate remains visible after confirmation. It does not replace the customer-stated draft address, create a PropertyAddress/job, or clear admission blockers.

New local-address.service.ts and its spec; customer-consent-browser transport/budget extension; existing customer-intake-journey fixtures; scripts/verify-address-journey.mjs and parent verification helper; execution board and evidence. No schema/package/migration, provider SDK/configuration, production module registration, routing change, real data, sending, charge, billing or release.

## Contract

Optional POST /customer-session/address requires explicit fixtureLoopback and injected address port; existing origin, Fetch Metadata, custom header, session/tenant, size and request-budget defenses remain. Exact fields: action, candidateId, confirmed, expectedRevision, operationId UUID, query, sessionToken, unit. Actions suggest/confirm/status/clear; confirm requires explicit acknowledgment and candidate from the saved suggestion. Status/clear require empty query/unit/candidate and false acknowledgment.

LocalAddressService accepts only a bounded injected fictional catalog. Shared customer-session lock, ongoing conversation/active tenant/customer checks, exact revision and credential recheck protect writes. Encrypted collectedData.localAddress holds query/unit, candidate IDs, selected ID, revision, catalog/area fingerprint and last operation digest. Writes preserve other collectedData; state and privacy-safe audit commit atomically. No raw address/unit in audit.

The fingerprint includes the catalog and all tenant area IDs, types, statuses, definitions and updatedAt values in stable order. A changed or added area invalidates replay/confirmation; status reports stale rather than silently promoting a historic result. The fingerprint is not a retained full historical policy document or production provider evidence. Results describe the read snapshot, not a continuously updated promise. Future consumption must revalidate current configuration.

Only canonical five-digit candidate ZIPs and explicit active ZIP definitions can yield FIXTURE_IN_AREA. Active malformed/unsupported definitions or no active area yield UNKNOWN. Explicit valid nonmatch is OUT_OF_AREA. ZIP+4 configured values match their first five digits. No routing fallback or formatted-text ZIP guessing is used.

Exact current operation replay writes once if policy is unchanged; changed payload/revision or stale policy refuses. New corrections replace the bounded state. Maximum 20 local mutations and 1000 area rows; no provider/production limit policy inferred. Status is read-only. Revision/state reset is not an automatic session restart.

Browser address/unit edits remove the displayed selection and result, requiring new suggestions/confirmation. Saved historical state is not erased by typing or clearing browser memory. Refresh with different current input does not display an old positive result. Clear saved test address is an explicit server mutation; clear private session only clears browser state. Pending network outcomes preserve an exact request for manual retry. Refusal retains draft fields.

All addressAuthorized, bookingAuthorized and deliveryAuthorized flags remain false. Fixture result does not prove real location, deliverability, occupancy, trade capability, availability, price, payment or identity. Unit text is confirmed locally, not independently validated.

## Validation

- 14 new ZIP policy cases; full backend 1723 passed, three existing skips, 91 passing suites.
- Build/lint/architecture/Prisma, JavaScript syntax and diff checks passed. Two backend dependency audits reported zero findings.
- Eight new real browser/disposable-PostgreSQL groups in address-journey-summary.json: selected explicit ZIP match, exact lost-response replay, unit edit/out-of-area, area edit/stale confirmation, inactive UNKNOWN, audit rollback/concurrent corrections once, forged session/privacy/no master-address/job writes, mobile/desktop/private clear.
- Additional direct checks include foreign tenant refusal and newly added area's fingerprint invalidation.
- Parent organization/admission/browser, phone and durable budget regression retained and passed. Address helper makes zero live provider calls and creates no master address/job; parent retains its prior fictional job and mocked phone operations.
- Local request limiter is reset between independent phone/address fixture groups, not the durable monetary ledger. No shared production traffic-budget claim.
- Initial audit action TypeScript narrowing, parameterized unit-test array shape and forged-credential test shape were corrected; final gates passed.
- Desktop/mobile screenshots visually reviewed; whitespace and labels improved. Disposable database removed. Existing pg concurrent-query deprecation remains.
- Standalone application UI tests/build not rerun: only backend-owned HTML/JS fixtures changed; real browser QA covers those. No new production or live verification acceptance.

## Exact review / reproduction

Review 61a0446..HEAD on codex/app-013-transactional-messaging. Inspect mobile/desktop/UNKNOWN screenshots and summary here. Confirm existing RoutingService is unchanged, address data remains encrypted session state, and no job/address master records are written.

```sh
npm run lint
npm run build
npm test -- --runInBand
npm run arch:check
npx prisma validate
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-address-journey-proof-20260910 PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
```

Local sockets/browser permission required. Verifier uses a random calldesk_org_* database on /tmp and cleans it afterward; no provider credentials. Governance: node scripts/docs-consistency-check.mjs.

## Next / progress

Stop for review. Next proposed bounded connection: carry the explicitly selected fictional address and unit into the local reviewed draft, with exact session/address revision and current service-area revalidation; no real verification, job/admission changes or booking authority. Provider selection, real validation semantics, retention/costs and activation remain separate. Phone budget does not authorize address-provider spend.

APP-013 sole Now; Next empty; FE-014 paused. APP-013 50% recorded scope / 0 of 12 accepted; onboarding 50% local / 0 of 6 accepted; pilot 0 of 12 accepted. No defensible overall engineering percentage or ETA.
