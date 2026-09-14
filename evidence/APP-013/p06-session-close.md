# APP-013 / 2B / P06 controlled session close

2026-09-14. Approved runtime-wiring item 2, from backend dd10b14 / governance 703bf76. No scope deviation. Local implementation/synthetic validation, not live demonstration or package acceptance.

## Changes and boundaries

- VerificationCleanupService accepts an explicit copied CONTROLLED_SESSION_V1 tenant binding for end only. Existing close-before-purge transactions reused; fixture sweeps/reference deletion stay fixture-only. Foreign tenant refuses. Closure audit uses controlled-session-cleanup actor, not fixture-cleanup.
- Loader wires a separate controlledLifecycle port. Transport projects only CLOSED/cleanupPending/fixtureOnly:false/deliveryAuthorized:false; malformed or fixture receipt refuses. No new endpoint.
- Bootstrap exposes sessionCloseAvailable only with server-owned controlled lifecycle. Existing page uses its existing forget/end action when available and clears this capability with private state. No browser flag creates server authority. Pending uncertain requests retain the existing local-clear behavior; clearing does not cancel a saved operation.
- Closed sessions cannot resume verification. Purge removes existing verification payloads and abandoned protected draft turns only; linked/submitted business records, immutable consent, audit rows, request counts and monetary holds remain. No general cleanup scheduler, production purge, schema migration or secret access.

## Validation

- Full Jest: 128 suites passed, one skipped; 2,341 tests passed, three skipped. Build, lint, architecture, schema validation and both npm audits passed; zero dependency findings.
- Actual loaded runtime DB test: synthetic START/CHECK, foreign close refusal, injected purge failure after committed close, retained encrypted payload while cleanup pending, further verification refused, successful repeated end, payload purged and monetary holds retained. No additional provider calls from close/retry.
- Six existing connected browser cases (accepted/outside/correction at 390/1440) close through actual service/HTTP transport, retain job/hold counts, confirm closed/purged state and empty private fields. Existing uncertain cases still exercise exact retry/local-clear without claiming cancellation. Existing full DB/browser, consent/rollback, shared budget/restart and liability gates pass. Mobile close screenshot visually inspected; no overflow or clipped status.
- No live provider calls. Existing non-failing pg concurrent-query deprecation warning remains. Logs /private/tmp/signmons-p06-close-{build,lint,tests,db}.log; artifacts /private/tmp/signmons-p06-close-evidence, including connected-close-accepted-390.png.

## Review and next

Review verification-cleanup.service.ts tenant/mode checks and transaction ordering; controlledLifecycle transport/loader wiring; page capability handling; verify-controlled-runtime.mjs and connected browser assertions. Confirm main remains unbound. Repeat the runtime card's full validation commands. Governance frozen/full consistency, 21 regression tests and whitespace checks required before push.

Remaining wiring: same-page phone-code-to-job journey using loaded binding and default-disabled startup/asset registration. Then separately approved release packet and capped run/owner closeout. Same three P06 items; no new section. Expired/revoked runtime cannot service new close requests; no background cleanup activation is claimed here.

Accepted remains 5/60 (8.3%), walkthrough 3/8 (37.5%). Provisional 4–8 weeks at 25–30 collaborative hours/week plus external waits remains low confidence; next timing review at ten accepted packages.
