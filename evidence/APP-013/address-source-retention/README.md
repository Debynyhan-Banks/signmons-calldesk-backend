# APP-013 address source and retention qualification — 2026-09-11

## Outcome

This documentation-only section qualifies the official Cuyahoga County CEGIS `Addressing_Sites_Streets` service as a conditional, fail-closed physical-county source for a future implementation and fixes the minimum Google Address Validation retention matrix. It does not connect either source to runtime, call Google, configure an account, modify tenant service areas or remove the existing `ADDRESS_NOT_VERIFIED` blocker.

The CEGIS source can produce a positive classification only when a current exact site-address record and its current linked road agree on country, state and county. Any boundary-side disagreement, ambiguity or unavailable evidence is `UNKNOWN`; there is no distance buffer, ZIP inference or routing fallback.

## Source identity and noncustomer audit

- Service: Cuyahoga County CEGIS `NCGIDE/Addressing_Sites_Streets`, ArcGIS FeatureServer, service item `facc7d99a6ec40a5b01f5240455b9e6d`.
- Layers: `SiteAddress` 0 and `RoadCenterline` 1. The service declares spatial reference WKID 102722 / latest WKID 3734, versioned data, change tracking and per-record `GlobalID` / `last_edited_date`.
- Site records expose structured country, state, county, status, validation state, unit fields, point/capture type and a centerline link. Road records expose address ranges/parity plus country/state/county on both left and right sides.
- The U.S. Census 2026 county file identifies Cuyahoga County as Ohio GEOID `39035`; this is the canonical policy identifier, not an address geocoder or positive proof by itself.
- Read-only aggregate query on 2026-09-11 returned 115,395 `Current` US/OH/Cuyahoga site rows, 388,008 null-status rows, 3,949 pending, 232 temporary and 20 other. Those groups reported validation status 2, whose published layer domain means validation is required with no calculation error. The same aggregate exposed one `Current` US/OR/Cuyahoga inconsistency. These facts prohibit trusting a county label alone.
- Read-only road query returned explicit cross-county sides including Cuyahoga/Lorain and Cuyahoga/Medina/Summit boundary segments. This supports a categorical boundary rule without inventing a numerical accuracy buffer.
- No individual customer address, Google request, credential, provider account, paid API or private dataset was used. The public aggregate and boundary queries were read-only.

## Fail-closed decision contract

| Evidence | Result |
| --- | --- |
| Unique exact current physical site record; US and OH; site county Cuyahoga; current linked road exists; both road sides Cuyahoga; unit requirements resolved; unchanged address and policy revisions | `IN_AREA` candidate |
| Same requirements, with one identical non-Cuyahoga county on site and both road sides | `OUT_OF_AREA` candidate |
| Road sides name different counties or the site and road disagree | `UNKNOWN` |
| Null/pending/temporary/retired/other status, validation error/unknown, missing link, duplicate match, stale edit identity or unsupported point/capture type | `UNKNOWN` |
| Missing/unconfirmed unit, PO box/nonphysical location, wrong country/state, postal-county/ZIP-only match or routing fallback | `UNKNOWN` |
| CEGIS timeout/outage, source identity change or admission-time recheck failure | `UNKNOWN` |

`Current` and validation status are gates, not proof by themselves. A future adapter must explicitly allow reviewed physical `pointtype` and `capturemeth` values; until that allowlist is approved, every record remains `UNKNOWN`. A future proof must bind the service item, both record edit identities, address revision, tenant coverage-policy version and query time into a canonical digest. Admission must recheck the source outside its database transaction and refuse stale/unknown evidence.

This source is conditionally qualified for implementation design, not accepted for live operation. Published metadata does not provide an availability SLA, a global immutable release number or a guarantee that all adjacent counties are complete. Outage is therefore `UNKNOWN`, record edit identity supplies freshness, and absence is never `OUT_OF_AREA`.

## Exact Google retention matrix

| Data | Runtime use | Persistence decision |
| --- | --- | --- |
| Customer-entered structured address and unit | Request input and correction | Encrypt in the existing session. After explicit customer confirmation, persist only a new customer-provided/confirmed copy under the future approved Signmons customer-data policy. No live implementation until owner/duration are named. |
| Google `formattedAddress`, `postalAddress`, `addressComponent.componentName`, USPS `standardizedAddress` | Confirmation display only | Transient end-user-scoped cache, maximum earlier of session expiry or 24 hours. Delete on abandonment; replace with the customer's explicit confirmed/corrected value on continuation. Never enter durable proof, logs, analytics, screenshots or backups. |
| Google component correction flags | Explain a correction prompt | Memory/transient request cache only; same earlier-of-session-or-24-hour expiry. Never use outside correction flow or persist after confirmation. |
| Google latitude/longitude | Optional same-request source matching only | Memory only; delete when county lookup completes or fails. Never write to database, log, trace, screenshot, analytics or backup. |
| Google Place ID | Optional same-request correlation | Google permits indefinite storage, but this MVP deliberately stores none. Keep transient only and delete with the operation. |
| Google verdict, granularity, metadata, nonlisted USPS fields, `responseId`, raw response and headers | Evaluate the immediate result/retry | Never durable. Keep only in process or the isolated transient operation cache; purge by the earlier-of-session-or-24-hour rule. No hashing or encryption is treated as permission to retain. |
| CEGIS raw site/road attributes, geometry and record IDs | Immediate county decision | Never copy raw attributes/geometry to durable customer records. Canonicalize the minimum gates in memory, then store only a keyed source-snapshot digest, source name, checked time and derived county GEOID/outcome. |
| Signmons receipt | Bind current proof to later admission | Durable fields only: Signmons operation ID, tenant/session references, address revision, customer-confirmed timestamp, validation/coverage checked and expiry timestamps, tenant coverage-policy version, source name/version, keyed CEGIS snapshot digest, county GEOID `39035`, and `IN_AREA`/`OUT_OF_AREA`/`UNKNOWN`. No address, coordinate or Google identifier. |

Google's non-EEA service-specific terms permit listed address values and correction flags to be cached for stated purposes up to 30 consecutive calendar days and require latitude/longitude deletion by 30 days. The design intentionally uses a shorter 24-hour ceiling and no durable Google content. Place ID is the documented indefinite exception, but the MVP does not need it. Public Terms/Privacy, Google Maps attribution, applicable billing-country terms and the Google/USPS data-sharing notice still require review before live use. Synthetic U.S. addresses must remain mocked; live tests require separately approved legitimate participants and addresses.

## Proposed validation settings and remaining approval

A future Google request is server-side, direct submit-only, `regionCode: US`, `enableUspsCass: true`, with no autocomplete or map. The result must be complete, premise-level (or valid subpremise when required), free of unresolved/missing components, DPV-confirmed for the supplied unit context and explicitly confirmed by the customer after any correction. Google validation proves deliverability quality, not occupancy, county, unit access, identity, payment, booking or messaging consent.

Before implementation, owner review must accept:

1. the conditional CEGIS gate and the still-unapproved physical `pointtype` / `capturemeth` allowlist;
2. the isolated transient-cache/restore-purge design and 24-hour ceiling;
3. customer-data retention duration and accountable deletion owner;
4. address budget, Google account/environment, alert recipient, stop-switch owner and legitimate live-test scope.

## Review and validation

Review this file with governance `GOOGLE_ADDRESS_MVP_CONTRACT.md`, `REAL_VERIFICATION_ADMISSION_PLAN.md`, `DATA_CONTRACTS.md`, the pointer/board/handoff and APP-013 ticket. This section changes documentation only, so responsive browser QA is not applicable and no prior screenshot is claimed as new evidence.

Final gates passed: backend build/lint, 92 passing suites and 1,753 passing tests with three existing skips, architecture check, Prisma validation, full/production zero-finding dependency audits and diff check; UI lint, 170 tests, 16-page static build, full/production zero-finding audits and diff check; governance consistency, four execution-placement tests and diff check. The first sandboxed backend test run failed only because HTTP-boundary tests could not open loopback sockets (`EPERM`); the permitted unchanged rerun passed. Existing Next workspace-root/deprecated-lint and PostCSS warnings remain nonblocking. No new browser surface exists, so no browser screenshot or responsive runtime acceptance is claimed.

Run:

```sh
npm run build
npm run lint
npm test -- --runInBand
npm run arch:check
npx prisma validate
(cd ui && npm run lint && npm test && npm run build)
git diff --check
```

Governance:

```sh
node scripts/docs-consistency-check.mjs
node --test scripts/execution-placement.test.mjs
git diff --check
```

Runtime remains `5fb4f36`; current feature-branch documentation tip is reviewed separately. APP-013 remains sole `Now`, `Next` is empty and FE-014 remains paused. Completion stays APP-013 50% recorded scope / 0 of 12 accepted, onboarding 50% local / 0 of 6 accepted and pilot 0 of 12 accepted. No defensible overall percentage or ETA.

No runtime/schema/dependency/UI change, Google call, provider configuration, paid action, tenant/service-area mutation, real customer data, merge, deployment, IAM/secret or billing action occurred.

## Official sources reviewed 2026-09-11

- https://gis.cuyahogacounty.gov/server/rest/services/NCGIDE/Addressing_Sites_Streets/FeatureServer
- https://gis.cuyahogacounty.gov/server/rest/services/NCGIDE/Addressing_Sites_Streets/FeatureServer/0
- https://gis.cuyahogacounty.gov/server/rest/services/NCGIDE/Addressing_Sites_Streets/FeatureServer/1
- https://tigerweb.geo.census.gov/tigerwebmain/Files/acs26/tigerweb_acs26_county_oh.html
- https://developers.google.com/maps/documentation/address-validation/requests-validate-address
- https://developers.google.com/maps/documentation/address-validation/build-validation-logic
- https://developers.google.com/maps/documentation/address-validation/policies
- https://cloud.google.com/maps-platform/terms/maps-service-terms
