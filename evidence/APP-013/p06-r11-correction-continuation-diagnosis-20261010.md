# APP-013 / 2B / P06-R11 correction-continuation diagnosis — 2026-10-10

Status: owner-approved local implementation complete; release and any live journey remain separately gated.

## Approved section and observable gap

Section APP-013/2B/P06-R11 requires one protected journey in which current phone access and an eligible corrected Cuyahoga address lead from customer review and explicit submit to exactly one correlated job. Enabled39 reached a reviewed submit, then returned `REFUSED` / `ADDRESS_CORRECTION_STATE_UNAVAILABLE` / `jobCreated:false` for request `95b60000-636c-4647-ba5d-702aabc76c78`. The package closed cleanly and is consumed.

Inspected source is focused backend HEAD `3cf8a9dc53d0282a35e6263a36d749c5b32f8e2e` plus preserved uncommitted APP-013 work. Existing correction, controlled-intake and governance changes remain dirty and are not reset or committed here.

## Root cause in the current contract

`ControlledIntakeComposition` owns one process-local `GoogleCorrectionSequence`. On the first address response, `ControlledIntakeVerificationService` stores Google's `responseId` in that volatile map for at most five minutes. The corrected follow-up requires `claim.priorSessionOperations > 0` and consumes the matching `previousResponseId`; if the next HTTP request reaches another process, or the original process restarts, the map is empty and the service returns exactly `ADDRESS_CORRECTION_STATE_UNAVAILABLE` before another provider call.

This is a deterministic architecture gap, not proof of which infrastructure event occurred during enabled39. Existing focused tests intentionally prove both behaviors: same-instance one-time consumption succeeds, while cache loss returns the observed refusal without a provider call. Four current suites pass, 47 tests total:

`npm test -- --runInBand src/communications/google-correction-sequence.spec.ts src/communications/controlled-intake-verification.service.spec.ts src/communications/controlled-intake-composition.spec.ts src/communications/controlled-intake-browser-result.spec.ts`

Google's current REST reference says the first response UUID must accompany a revalidation request, and its updated-address guide directs follow-up validation to use the first `responseId` as `previousResponseId`. Current Signmons contracts simultaneously prohibit durable Google identifiers/raw provider payloads and do not permit returning a provider identifier to the browser. Therefore replacing the map with database persistence or exposing the raw ID is not an authorized routine fix.

## Alternative 1 — recommended bounded repair

Permit a **short-lived encrypted correction-continuation envelope** carried only in the initiating page's JavaScript memory:

- Reuse the already injected `ConversationMemoryCipher` AES-256-GCM key, common to instances of the same revision. Do not add a key, datastore, table, migration or provider.
- After `CORRECTION_REQUIRED`, encrypt a strict versioned object containing only the Google response UUID, purpose, tenant/session/conversation binding, intent/revision, policy/organization binding, and expiry no later than the current session expiry or five minutes.
- Return only ciphertext as an opaque continuation value. Never return the raw UUID. Keep it out of URLs, cookies, local/session storage, DOM text, logs, analytics, audits and database/backups.
- The page holds the opaque value in one in-memory variable, includes it only with the corrected reviewed submit, and clears it on use, edit, refusal, expiry, pagehide or private-session clear.
- Any instance decrypts and validates the full binding before the second provider request. Missing, malformed, foreign, stale, substituted-address or first-submit continuation refuses before provider access.
- Existing durable address-ledger locks and the two-operation session ceiling remain the replay/concurrency fence: one corrected follow-up can claim the second operation; a competing/new third operation is refused. No hold is released or reset.

This changes the current provider-derived-data boundary by allowing encrypted, ephemeral, browser-carried state. It needs explicit owner approval before implementation.

## Alternatives not recommended

Alternative 2 stores encrypted continuation state in PostgreSQL with TTL and cleanup. It would require schema/retention/backup/cleanup/recovery decisions and materially expands 2B.

Alternative 3 relies on one Cloud Run instance or session affinity. Process survival and request affinity are not an acceptance-grade continuity contract, so the existing refusal can recur.

Alternative 4 pauses 2B. The no-job refusal remains safe; no more journey or provider cost occurs.

## Proposed finite implementation card

1. Add one default-disabled correction-continuation codec that seals/opens only the strict bound object through injected `encrypt`/`decrypt` ports. Exit: positive, malformed, expired, foreign-session, foreign-policy, wrong-intent/revision and raw-ID non-disclosure tests pass.
2. Replace `GoogleCorrectionSequence` in controlled composition with the codec; pass the existing cipher from `loadControlledIntakeRuntime`. Exit: a first service instance can issue and a fresh second instance can consume the opaque continuation exactly once through existing ledger limits.
3. Extend the strict controlled submission and browser projection with optional `correctionContinuation`, allowed only on `CORRECTION_REQUIRED` response and corrected follow-up. Exit: extra/contradictory fields refuse, and admitted/refused/uncertain receipts never return it.
4. Hold the ciphertext only in fixture-page memory and clear it on every terminal/invalidation lifecycle. Exit: desktop/mobile synthetic browser tests complete correction across a forced composition replacement, while edit/expiry/pagehide/duplicate paths make no extra provider call or job.
5. Run focused concurrency/restart/replay/negative tests, full relevant controlled-intake tests, build, lint, architecture, governance baseline/consistency and whitespace checks. Exit: no regression or unauthorized authority field; no live call, deployment or migration.

Expected implementation files/interfaces: new `src/communications/google-correction-continuation.ts` and spec; `controlled-intake-verification.service.ts` and spec; `controlled-intake-composition.ts` and spec; `controlled-intake-runtime.ts` and spec; `controlled-intake-submission.ts` and spec; `controlled-intake-browser-result.ts` and spec; `customer-consent-browser-transport` tests; fixture journey JS and browser verifiers. Retire the volatile sequence only after all consumers are replaced. HTML, Prisma schema and public downstream job contracts should not change.

Required test commands include the focused Jest group, `npm run build`, `npm run lint`, `npm run arch:check`, `node scripts/verify-controlled-intake-ui.mjs`, applicable disposable PostgreSQL/browser gates, both repository governance checks and `git diff --check`.

## Boundaries, rollback and decision

## Approved local implementation and evidence

The owner approved Alternative 1 and the encrypted ephemeral browser-carried correction-continuation boundary for bounded local implementation and synthetic testing only. The volatile process-local sequence has been replaced by a strict `GoogleCorrectionContinuation` codec using the existing `ConversationMemoryCipher`. The controlled transport accepts the opaque value only on a corrected v2 submit, projects only `sessionToken` and `requestId` into the durable address ledger, and never exposes the raw provider UUID.

The page keeps ciphertext only in JavaScript memory. It clears on terminal admission/refusal, session clear and pagehide. The existing correction screen supports both accepting the suggested address and typing a corrected address; therefore the continuation remains during those address-field edits, while reviewed state is invalidated and explicit review/submit is required again. The server binds the envelope to tenant, session, conversation, service category, transcript revision, policy version, organization approval and expiry; Google then revalidates the newly reviewed address. The new request intentionally has a new request UUID, so the envelope is not bound to the first request UUID. No new authority or provider operation is created by editing or previewing.

Local verification:

- Seven focused Jest suites: 187 tests passed, including strict ledger projection, malformed/expired/foreign binding, transport projection, correction result privacy and controlled composition.
- Full backend Jest suite: 132 suites and 2,495 tests passed; one suite/three tests remained intentionally skipped.
- `npm run build`, `npm run lint`, `npm run arch:check`, JavaScript syntax checks and backend `git diff --check` passed.
- Standalone browser matrix: 52/52 cases passed at 390px and 1440px, including suggested and manually entered correction, invalidation, refusal, uncertainty, lost acknowledgement, duplicate submit and session expiry. Evidence: `/private/tmp/signmons-correction-continuation-ui-final-20261010`.
- Disposable PostgreSQL 18 plus real local HTTP/browser harness passed both viewports for admitted, outside-area, uncertain, ordinary correction, postal-format correction, repeated-correction ceiling and exhausted capacity. It also passed the connected page/transport journey and exact replay, with synthetic SDK/fetch ports and zero live provider calls. Evidence: `/private/tmp/signmons-correction-continuation-loaded18-complete-20261010`.

This establishes local implementation behavior only. No image build, upload, deployment, traffic, migration, cloud/database/provider access, phone code, message, customer job or new live journey occurred.

No implementation, schema/migration, live database/provider/Twilio/Cloud read, code request, job, deployment, traffic/IAM/secret change or additional journey occurred in this diagnosis. Rollback is omission of the optional continuation port: controlled correction fails closed as today. Successful local tests would establish code behavior only; a build/release and any final acceptance journey remain separately approval-gated.

Owner approval was received and the bounded local implementation is review-ready. P06 remains 12/14; R11/full R12 remain open; accepted milestones remain 3/8. The approved provider-derived-data boundary is implemented locally. No further scope deviation.
