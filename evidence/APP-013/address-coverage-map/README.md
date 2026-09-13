# APP-013 address / service-area map — 2026-09-10

Completed the latest approved inspection/mapping section at backend 77c2744, governance b37ae9b after remote refresh. Full contract map, source references and next local acceptance cases: governance ADDRESS_COVERAGE_CONNECTION.md.

Findings:

- customer-intake-draft.ts accepts address text, not validated structured location.
- customer-intake-continuation.service.ts:635–638 writes random googlePlaceId, empty components and zero coordinates; lines 675–676 retain NOT_VERIFIED. These are not provider evidence.
- schema.prisma provides PropertyAddress, ServiceArea and CustomerCoverageCheck, but no customerCoverageCheck application usage was found under src. Pre-admission evidence needs a session-scoped model, not premature master-address creation.
- SaveServiceAreaDto and RoutingService support tenant-scoped audited active ZIP configuration.
- RoutingService:383–390 permits covered:true with no base routing rules; lines 492–545 can extract ZIP from formatted text. Neither supplies address validation or affirmative configured geographic coverage.
- BookingReadinessPreviewService retains contact/address blockers. No blocker was cleared.

This is documentation only. No code, API, UI, schema, package, provider configuration, live service, billing, real data or release change. Existing dirty saved checkouts remain preserved.

Validation: existing full backend 1709 passing tests / 3 existing skips; build, lint, architecture and Prisma validate passed. Governance docs-consistency-check and git diff --check passed. No new tests, browser QA, dependency-audit refresh or acceptance claim is made for this source-map-only section.

Review the governance reuse table and six acceptance cases. Next proposed implementation: fictional address suggestion/selection/confirmation plus separately labeled explicit active-ZIP coverage in the same customer journey. Missing/invalid configuration stays UNKNOWN. Bind session/address/unit/area-policy revisions; corrections invalidate prior results. No live address provider decision is needed for this local proof. Do not reuse routing fallback as coverage or clear booking authority.

Reproduce the audit with rg for customerCoverageCheck/geocod/autocomplete/addressvalidation under src and inspect the source files above; distinguish no-match search exit 1 from tool failure. Run npm test -- --runInBand, npm run build, npm run lint, npm run arch:check and npx prisma validate for existing regression. Run node scripts/docs-consistency-check.mjs in governance.

APP-013 remains sole Now; Next empty; FE-014 paused. APP-013 50% recorded scope / 0 of 12 accepted; onboarding 50% local / 0 of 6 accepted; pilot 0 of 12 accepted. No overall engineering percentage or ETA.
