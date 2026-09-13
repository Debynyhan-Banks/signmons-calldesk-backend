# APP-013 / 2B inactive OAuth address transport

2026-09-12. Owner approved implementation after confirming the test should run on the Signmons server. Parent backend 8ac66ad / runtime 6c9f660; governance c9e762b. Existing focused branches retained, fetched and matched upstream before changes. Original saved checkout's unrelated dirty files were not changed.

## Scope and result

Added src/communications/google-address-oauth.transport.ts and its spec. Uses existing google-auth-library dependency; no package, schema, UI or existing fixture-adapter changes. Default disabled and no module/controller/worker registration or environment switch. Test ports inject synthetic OAuth and fetch; the default-disabled test never acquires ADC. Explicit future composition is required; the constructor boolean is not a security/authorization or budget boundary.

Fixed direct Google validateAddress HTTPS endpoint, POST, OAuth bearer and Signmons quota project; only strict US/OH structured input with CASS true. Snapshot before credentials; no address/token in URL. No API key, downloaded credentials or arbitrary endpoint. Eight-second deadline covers credentials, fetch and streaming response; late token cannot dispatch. Redirects prohibited; no transport retry. JSON response limited to 64 KiB, with result object required. Non-success, malformed/oversized response and transport/auth errors return sanitized UNAVAILABLE. RESPONSE remains internal transient content, not proof; callers must never log, persist or return it wholesale.

No real provider call, credentials acquisition, database writes, IAM/billing/infrastructure changes, production migration, deployment, SMS or customer activity. Existing GoogleAddressAdapter retains fixtureOnly and false verification/admission behavior. County qualification is not bypassed.

## Validation

- 34 new mocked tests passed, including default off, no registration, fixed request, invalid inputs, missing tokens, HTTP errors/redirect, malformed/oversized JSON, deadline before token, hanging HTTP/stream, cancellation and input mutation.
- Full backend: 105 suites passed, one skipped; 1,989 tests passed, three skipped. No live network in new tests.
- Production build, lint, architecture check, Prisma validation and focused Prettier passed.
- npm audit --omit=dev --audit-level=low: zero vulnerabilities. No dependency updates.
- Governance docs-consistency-check and whitespace checks passed.
- Browser QA/UI build not applicable: no rendered page, route, UI or active transport integration changed. Prior fixture screenshots are not claimed as proof of OAuth integration. No database fixture or crash suite needed for this stateless transport.
- Corrected development failures: production build caught getAccessToken's possible undefined result; lint caught untyped mock/stream values. Final gates passed after explicit type narrowing. No failed provider request occurred.

Reproduce from the focused backend: npm run build; npm run lint; npm run arch:check; npx prisma validate; npm test -- --runInBand; npm audit --omit=dev --audit-level=low. Run node scripts/docs-consistency-check.mjs in governance. Review both new source files and confirm no imports/registration outside their own test.

## Remaining approval/release checklist (not implemented)

1. Qualify least-privilege OAuth access for the existing runtime identity and Signmons quota project, including serviceusage.services.use. Direct project IAM inspection previously showed only Firebase Auth Viewer; inherited/effective authorization was not established. Do not grant broad Editor/Owner or download keys. Present exact permission diff before any IAM change.
2. Compose this transport behind the existing durable operation reservation, trusted caller/session, total test cap, deadline and uncertain-outcome handling. Google daily quotas reset and do not constitute a one-time spend allowance.
3. Apply existing semantic correction/current-proof checks without promoting fixture receipts. Complete county authority/source qualification separately.
4. Review explicit staging revision/configuration and rollback, retention/notices, exact participant address, attempts/spend and test window before deployment or real requests. No present constructor enablement is approved by this code checkpoint.

The live server inspection in preceding turns found Cloud Run signmons-calldesk-staging in us-east5 with runtime identity signmons-calldesk-runtime@signmons.iam.gserviceaccount.com and no VPC/static-egress annotation. Previous console confirmation set 10 validation requests/day and 5/minute. These account observations were not re-fetched during this code section. No static IP infrastructure is provisioned.

Official references: https://developers.google.com/maps/documentation/address-validation/get-api-key ; https://developers.google.com/identity/protocols/oauth2/scopes ; https://docs.cloud.google.com/run/docs/securing/service-identity . OAuth scope is cloud-platform; a scope is not an IAM grant or evidence of successful authorization.

Review-ready only. Fixed walkthrough remains 3/8 accepted (37.5%); five acceptances remain, not five equal engineering sections or whole-MVP percentage. Next is the bounded controlled-operation composition/permission review within 2B, not parked 3C messaging work or another fixture rewrite.
