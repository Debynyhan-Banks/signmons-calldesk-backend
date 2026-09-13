# APP-013 P1 tenant SMS policy registry — 2026-09-12

Owner approved P1. Backend registry/reader implementation is review-ready; no live publication, capture, sending or release is enabled.

## Completed

- TenantSmsPolicyVersion stores immutable public policy content and canonical digest. Database triggers reject edits/deletes; replacements create new versions.
- TenantSmsPolicyHead records the current version, lifecycle, monotonically increasing application revision and tenant-bound audit reference. Tenant policy locks serialize concurrent changes; expectedRevision rejects stale writes. A replacement draft immediately makes capture eligibility unavailable until it completes review; it does not keep using the superseded version silently.
- Existing owner/admin context patterns enforce access; wrong tenant/role and impersonation refuse. Changes and audits commit atomically. Operational read supports current-revision reload after an unconfirmed commit; replaying an old revision cannot duplicate the change.
- Exact content schema includes legal sender, transactional purpose, support email, disclosure/version, Privacy/Terms URLs/versions and canonical effective/expiry timestamps. URLs require a server-owned exact HTTPS allowlist and reject credentials, query/fragment tokens, unsafe schemes and noncanonical encodings. No URL is fetched.
- DRAFT → REVIEWED → PUBLISHED_VERIFIED → CAPTURE_ELIGIBLE transitions and suspension are audited. Publication requires a trusted, exact tenant/version/digest/reference/deadline attestation. P1 only accepts explicitly fictional attestation; a live attestation is refused.
- Transaction-scoped readForCapture projects public content plus version/revision binding and always returns fixtureOnly=true, liveCaptureEnabled=false, deliveryAuthorized=false. Current allowlist, publication evidence, state and time are rechecked. Old bindings refuse after replacement or suspension.

## Boundary

This is an inactive application seam, not a new controller, dashboard, published policy page or registered production provider. P2 connects this reader/binding to the existing real-consent and STOP/suppression path; the intake is not silently switched to this registry. Existing fixture tables remain non-authoritative. No four-event preference, Customer.consentToText, SmsConsentRecord or delivery logic changed.

The trusted publication resolver and tenant URL allowlist are injected test configuration, not a production publication checker. Real policy review, hosting/effective date, key/retention lifecycle and capture/send release remain gated. Immutable records require an explicitly governed retention/deletion design before production rollout; no retention duration is selected here.

## Changed files

- src/communications/tenant-sms-policy.ts: content, URL, revision and reference validation.
- src/communications/tenant-sms-policy-registry.ts: scoped writer/lifecycle/reader application boundary.
- src/communications/tenant-sms-policy.spec.ts: domain rejection and canonical digest tests.
- prisma/schema.prisma and migrations/20260912160000_tenant_sms_policy_registry/migration.sql: isolated registry schema and immutable history.
- scripts/verify-tenant-sms-policy-registry.mjs and verify-durable-fixture-sms-consent.mjs: real disposable-database checks plus existing browser/durability regression.

## Validation and exact review steps

Build, lint, architecture, production dependency audit (zero findings) and whitespace checks passed. Final Jest: 102 suites and 1,941 tests passed; one suite/three tests skipped. One earlier run exited 139 without finishing; unchanged rerun and final rerun passed. The runner interruption is unresolved, not hidden as a clean first run.

The local PostgreSQL harness passed 20 groups: six new registry groups and fourteen existing durable-intake/browser groups. Registry evidence contains four immutable versions and sixteen audits. Zero provider calls, live consent/customer grants, delivery events or production database writes. The disposable Unix-socket database was removed after the run; fixtures can be recreated by the script.

1. Read registry/summary.json: inspect exact public projection and three false-authority/test flags; compare lifecycle, tenant, immutable-history, rollback and expiry checks.
2. Review transaction serialization, expectedRevision, publication attestation checks and readForCapture expected-binding comparison. Verify CommunicationsModule has no registry registration and no caller writes live consent.
3. Browser screenshots at 390px/1280px were visually reviewed; they prove the existing durable fixture journey still works, not a new policy editor or registry-to-live-capture connection. Other intake responses remain mocked.
4. Reproduce with npm run build, npm run lint, npm run arch:check and npm test -- --runInBand. Set PLAYWRIGHT_MODULE to the installed Playwright index.mjs and SMS_INTAKE_EVIDENCE_DIR to an explicit output directory, then run node scripts/verify-durable-fixture-sms-consent.mjs against the local /tmp PostgreSQL socket. The runner creates/drops only its validated randomly named fixture database and applies migrations there; never substitute production credentials.

Next proposed section: P2 consent/suppression integration, reusing these seams with capture and sending disabled until separately approved. APP-013 remains Now; current 2B and accepted 3/8 milestones (37.5%) unchanged. P1 is not a ninth milestone or whole-MVP completion. No merge, deployment, provider setup, public policy or production migration.
