# APP-013 / 2B / P06-R11 local correction-limit repair — October 1, 2026

Owner approved APP013_P06_R11_CORRECTION_LIMIT_REPAIR_20261001.md at07:55Eastern. Prior live window ended07:45 and was not extended. Code and synthetic local testing only. Existing main focused checkout3cf8a9d with prior changes preserved; inspected runtime baseline5a49a3b. No frozen milestone reset.

## Implemented behavior

ControlledIntakeVerificationService now uses the existing trusted priorSessionOperations count: if the second permitted operation still returns CORRECTION_REQUIRED, its work result is the existing REFUSED/VERIFICATION_LIMIT_REACHED outcome without a candidate. Executor durable OBSERVED completion remains required before that definitive result is projected. Failed, unconfirmed or late completion remains UNCERTAIN without a candidate/reason leak. A valid corrected second response still reaches existing current-proof admission once.

The existing browser terminal handler retains the draft/reference and disables submission/edit/retry rather than inviting a third call. No browser runtime, parser, ledger, interface, schema, provider configuration, cap, retention or claim semantics changed. Only service7lines plus its spec, loaded-browser harness and adapter investigation spec changed in this repair. Prior unrelated edits preserved. Isolated four-file delta: /private/tmp/r11-correction-limit-patch-20261001.diff; SHA256619dbd304fa0ef9fbf858ff16acf09f3393a1e9989c196b452e6b800c7ac48b9. Pre-edit file copies: /private/tmp/r11-correction-limit-before-20261001. No commit/merge/deployment performed.

## Fresh evidence

- New service regression failed before fix: expected terminal refusal but got CORRECTION_REQUIRED/candidate;1failed/24passed. After fix25/25service tests passed. Valid secondresponse, missing sequence cache, stale/foreignauthority and uncertainty cases preserved. After log /private/tmp/r11-correction-limit-before-20261001/service-focused-after.log.
- Adapter investigation59/59 passed, including two new two-pass conflicting street/ZIP fixtures. These document existing strict behavior, not a matcher relaxation.
- Full unit suite132passed,1existing skipped;2432tests passed,3skipped. Log /private/tmp/r11-correction-limit-unit-20261001.log. No old test count presented as fresh.
- Lint and local compile passed: /private/tmp/r11-correction-limit-lint-20261001.log and /private/tmp/r11-correction-limit-build-20261001.log. Architecture, JavaScript syntax and whitespace passed.
- Complete existing disposable PostgreSQL18 and browser harness passed with matching fresh compiled outputs. Artifact directory /private/tmp/r11-correction-limit-evidence-0585d580671a. Twelve loaded cases: accepted/outside/unknown/correction/repeated-correction/capacity at390/1440px. Repeated correction uses exactly2synthetic addresscalls,2distinct OBSERVEDoperations, zerojobs, candidateabsent, retainedfields, hidden furthercorrection and disabledsubmit/edit/retry. Native disabledcontrol clicks cannot create a third call. Firstcorrection successfulsecondsubmission and existing recovery/concurrency/authority paths pass.
- Harness exit0, remaining fixture databases0; owned socket-only cluster stopped and removed. All provider ports synthetic; liveProviderCalls0. Phone-width screenshot visually reviewed; disabled controls, retained draft and terminal message visible. Browser artifacts loaded-repeated-correction-390.png and1440.png in evidence directory.
- Independent source/harness review found no material issues or fabricated backend result. No additional live/DB/provider read, paid call, code request, image build/upload, cap increase, hold reset or runtime action.

## Remaining address-policy issue and scope

Synthetic street case: structured component says123FictionalStreet while postal line says123FictionalSt. Selecting the postal suggestion still conflicts with the structured component. Synthetic ZIP case: postal44101-1234 versus structured44101 behaves similarly. Existing strict adapter explicitly treats these as correction, so neither case establishes authoritative eligibility. No actual Google response from today's run was inspected; these are conditional reproduction findings, not a claimed cause for the user's address.

A future address-matching decision must define how inconsistent provider representations and explicit customer confirmation are treated while preserving fresh proof, exact tenant/session/revision and county eligibility. Automatic abbreviation/ZIP equivalence and a new live attempt are outside this completed repair. Do not raise limits to conceal the loop. Current live image remains unchanged and consumed approvals remain closed.

## Handoff

Card checklist1–4 complete: trusted terminaldecision, focused failure/positive/uncertainty proof, connected desktop/mobile two-call regression, local QA and evidence. Implemented and locally tested only; not live-demonstrated or owner-accepted as R11. Next observable result is a bounded reviewable address-matching decision, followed by any separately approved implementation/release; no new paid test prepared. Implementer owns that technical recommendation; owner approves any material policy/live change. P0612/14,R11/fullR12open;accepted1A/1B/2A3/8 unchanged. No scope deviation.
