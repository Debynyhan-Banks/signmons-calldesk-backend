# APP-013 / 2B / P06-R11 — local street-record compatibility repair

## Authority and change

Owner approved Alternative1 for local repair and synthetic testing on October12, before source edits; see governance `APP013_P06_R11_STREET_RECORD_COMPATIBILITY_DECISION_20261012.md`. Approved checklist1–4 is complete locally. No new acceptance section, provider, interface, retention permission or external action.

Source HEAD `3cf8a9dc53d0282a35e6263a36d749c5b32f8e2e`; focused backend/governance branches remain `codex/p06-r08-recovery-20260918`. Four before copies/hash manifest preserve prior dirty work under `/private/tmp/r11-street-record-repair-20261012/before`. No commit/push performed.

The sole runtime change is `google-service-area.ts`: require exact H or S instead of H only. Every address-component, required unit, US/OH/county consistency, mailbox, confirmation, freshness, identity and downstream authority check is unchanged. Unsupported F/G/P/R, missing/malformed/lowercase values remain UNKNOWN. This does not claim full commercial-record support. Physical address type alone cannot create a job.

Existing evaluator and verification-service suites now run for both H/S. Explicit negative cases cover unsupported/malformed types, missing structured county fields and PO-box metadata. Existing connected loaded-browser harness runs its seven cases for each type at390/1440, with distinct screenshot names. No new demo, production logging or stored provider field was introduced.

## Validation

Before runtime patch: parameterized regression tests reproduced23 failures on S cases;157 passed. The exact old predicate rejects otherwise valid S responses. After repair: focused3 suites/288 tests pass. Final full suite:132 pass,1 existing skipped suite;2604 tests pass,3 existing skips. Lint and build pass. Browser script syntax passes. No change to acceptance assertions or skipped cases.

Full existing disposable PostgreSQL18/database/browser harness exits0. Loaded browser matrix28/28: H/S ×390/1440 × accepted,outside,unknown,correction,format-correction,repeated-correction,capacity. Accepted/corrected paths assert one job; lost-ack exact replay adds no job/provider call. Refusals, late/failed observations, changed proofs, duplicate/concurrent admission, rollback recovery and retained ledger holds are exercised by the existing service/full database harness.84 synthetic phone invocations and36 synthetic address invocations;0 live provider calls. No preprovisioned phone proof in loaded cases. Other existing operator/browser regression checks also pass.

The first full test invocation was blocked by sandbox socket permissions; rerunning the approved synthetic suite with local socket access passed. PostgreSQL initialization was first blocked by shared-memory permissions; the next startup needed an explicit valid locale. After setting LC_ALL=C and using a unique alphanumeric socket directory, the isolated harness passed. No application policy was changed to address environment failures. No live operation was retried.

Cleanup verified: fixture database count0; owned socket-only cluster stopped, postmaster.pid absent. Stopped cluster path is recorded in cleanup.json. Local providers were replaced by fictional ports; no live database URL or provider secret was supplied.

Artifacts: `/private/tmp/r11-street-record-repair-20261012/` contains before/after manifests, focused-tests.log, full-tests-final.log, lint-final.log, build.log, browser.log/screenshots, cleanup.json and review-summary.json. Isolated four-file patch `local-change.patch` SHA256 `55bd81304fbd8a99cd169aa7cf1bf872dad0eb8af5125b5f4358014217198b13`. Direct before/after comparison confirms the runtime delta is exactly one predicate. Reverting this patch preserves earlier fixes; live runtime remains unmodified.

## Handoff

Implemented and locally tested: approved checklist1–4. Live-demonstrated/owner-accepted: not claimed. The historical enabled41 response was not retained, so the precise cause of that refusal remains unknown; this repair resolves the demonstrated S compatibility restriction only.

Next observable result is review of this isolated delta; implementer can prepare a source-bound build/release proposal if requested. Owner controls any upload/build/deployment/live journey/allowance approval. No new execution package, phone allowance or live window exists. Prior phone19/USD9.50 and address12/USD1.20 holds remain unchanged; consumed runs must not be replayed. P06 remains12/14; R11/fullR12 open; accepted1A/1B/2A remain3/8. No scope deviation from approved Alternative1.

Final repository gates: backend governance baseline, governance frozen baseline and consistency, all21 safeguard tests, architecture and whitespace checks in both repositories passed after the changes.
