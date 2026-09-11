# Exact local correction confirmation

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
