# Exact local correction confirmation

## Protected browser checkpoint (2026-09-11)

The existing customer-intake-journey page now includes an explicitly enabled local correction review. It reuses the protected customer-session transport, verified credentials, origin/Fetch Metadata checks, exact input shape, no-store responses and local request budget. The correction port is absent by default and refuses outside an explicit fixture binding. The loopback fixture composes the real Google adapter and LocalAddressCorrection with fictional provider output, and locks/reads the current customer conversation before use. Tenant/session/expiry and conversation updatedAt changes invalidate pending state; revisions are server-generated, not trusted browser claims.

The customer sees the exact candidate, explicitly checks acknowledgment and confirms that candidate/revision. Changed address input, wrong candidate, replacement, closed session and malformed claims refuse. Address edits clear displayed state; conditional best-effort discard avoids clearing a newer candidate. If disconnected, in-memory expiry remains the fallback. Browser copies expire and clear on private reset/pagehide. The fixture holds one candidate only, serializes requests and is deliberately not a production multi-customer service. Its database lock surrounds an injected immediate mock, never a real network request; a live adapter must not be inserted into this composition. No Google network calls, candidate database writes, job admission, sending or automatic draft rewriting are introduced.

Validation: full backend 94 suites / 1,818 tests pass, three existing skips; build/lint/architecture/diff pass. Two new transport tests cover default denial and protected dispatch. Existing 14 correction / 49 adapter tests remain green. The complete organization-profile disposable PostgreSQL + Playwright parent verifier passes, including the new correction journey and existing organization/customer/operator/phone/address/payment-policy regressions. Final browser evidence: `/private/tmp/signmons-correction-browser-final-20260911/correction-summary.json`, `correction-mobile.png` (390px viewport) and `correction-desktop.png` (1280px). Both screenshots visually inspected; no horizontal overflow, browser storage or page errors. The initial mobile screenshot inherited the parent desktop viewport; the final verifier explicitly sets both sizes. The disposable fixture database was cleaned up. Existing pg concurrent-query deprecation remains; no dependency changes or fresh vulnerability-audit claim.

Reproduce from this feature worktree after `npm run build`:

```sh
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-correction-review PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
```

Review the correction screenshots, then inspect `scripts/verify-correction-journey.mjs`: enter 123 Fictional St / Example / 44101, review 123 Fictional Street, confirm explicitly, alter city to clear confirmation, replace the proposal and reject the old candidate. These are synthetic fixtures, not usable live-provider test addresses. The script also refuses a closed server session and unknown claims.

Next after review: size the already-planned verification-operations package (shared address cost reservation, bounded attempts, uncertain outcomes and retention/cleanup) before real provider connection. This closes the local correction-display/confirmation slice only, not S1 intake-to-job or APP-013 acceptance. County qualification, live identity/provider settings, operational controls and current-proof-to-job composition remain gates. APP-013 scope index stays 50%, acceptance 0/12; onboarding local 50%, acceptance 0/6; pilot 0/12. No defensible overall build percentage or ETA.

## Prior service-only checkpoint

Scope: unregistered service-level S1 proof, not a completed browser journey. GoogleAddressAdapter.preview exposes only correction-display postal fields after its existing gates; validate keeps its previous privacy-safe status shape. LocalAddressCorrection holds one candidate per instance, requires a trusted readScope callback and binds tenant/session/address revision/session deadline both sides of the asynchronous validation. The caller must maintain that server-owned revision on every relevant edit; request-supplied claims are not authentication.

The proposal always requires explicit confirmation, even if the Google fixture reports REVIEW. A random candidate ID selects the exact stored display values; submitted replacement fields refuse. Successful confirmation returns a fresh customer-confirmed copy, never a verified-address proof. Replay returns the same content only while context/expiry remain current. Clear/replacement invalidates earlier and in-flight proposals; process loss refuses rather than fabricating a durable receipt. Pending storage is memory-only, bounded to one candidate and earlier-of-session/24-hour expiry with timer cleanup plus checks on access. Caller must clear on session lifecycle events and discard browser copies; production cleanup/distributed persistence is not implemented.

All responses keep fixtureOnly true, addressVerified/admissionAuthorized false and county UNKNOWN. No provider HTTP client, endpoint/auth registration, schema/database writes, logs, raw Google response persistence, browser UI, billing or deployment.

Validation: 14 correction tests compose the actual Google adapter with a synthetic response; 49 existing adapter tests also pass. Full backend 94 passing suites / 1,816 tests, three existing skips. Build/lint/architecture/diff pass. An initial unused-variable lint issue was fixed. No browser evidence is claimed; this has no registered UI route. Existing dependency audit results are historical; packages did not change.

Review files:

- src/communications/google-address.adapter.ts: status-only validate vs transient preview
- src/communications/local-address-correction.ts: exact proposal/confirmation boundary
- src/communications/local-address-correction.spec.ts: wrong scope/revision/expiry, explicit true, tampering, replay, mutation, disabled/malformed provider, in-flight edit/clear, process loss and timer purge

Reproduce: npm test -- --runInBand local-address-correction.spec.ts google-address.adapter.spec.ts; npm run lint; npm run build; npm run arch:check; npm test -- --runInBand. Full HTTP regression requires loopback permission.

Next S1 exit proof: integrate into existing protected local customer review with verified identity/session reads and invalidation on edits; browser must display and confirm the same candidate. No production activation or county bypass. Operations/reconciliation/current-proof-to-job connection remain subsequent audit packages. APP-013 scope index 50%, acceptance 0/12; no new pilot acceptance.
