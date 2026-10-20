# APP-013 / 2B / P06-R11 verification-limit refusal — local evidence

Owner-approved bounded local correction; governing card: APP013_P06_R11_LIMIT_REFUSAL_CARD_20260930.md. Source baseline backend 3cf8a9d plus the previously documented local capacity harness changes. Changes remain in the working tree.

## Result and boundaries

Previously, the existing local browser fixture with six exhausted account/tenant holds returned generic UNCERTAIN despite no new operation, address dispatch or job. Controlled ledger capacity checks now mark a trusted VERIFICATION_LIMIT_REACHED refusal only before creation, after matching existing operations are considered. The executor recognizes that marker only during reserve. Claim, transport, observation and unknown/forged failures remain uncertain. Legacy fixture result types remain unchanged.

The existing browser projection allowlists REFUSED plus the safe reason, preserves the request identity and denies booking/payment/dispatch/delivery authority. The page retains the draft and reference, states no job was created for this request, directs the customer to the office, and hides/disables retry and prevents editing/new submission on that pending request. Existing manual clear cannot reset server holds. No policy, cap, hold, schema, endpoint or retention change.

## Fresh verification

- Full unit suite: 132 passed suites, 2413 passed tests; one suite and three tests remain skipped. Log: /private/tmp/r11-limit-unit.log.
- Lint and build passed; build log: /private/tmp/r11-limit-build.log.
- Existing complete organization PostgreSQL/browser harness passed, including 10 loaded customer browser cases at 390/1440 pixels: accepted, outside, unknown, correction and capacity at each width. Capacity cases made zero address calls, retained six operations and created no job, kept the draft and suppressed retry. Normal lost-ack recovery and correction remain covered.
- Artifact directory: /private/tmp/r11-capacity-evidence-1d340ed9a61d. Harness exit 0; remaining fixture databases 0; owned socket-only cluster stopped and removed. Synthetic external transports only; no live provider calls.
- Initial un-escalated unit invocation encountered sandbox EPERM on existing HTTP listeners and was interrupted; rerun with local listener access passed. Initial build exposed legacy executor return-union incompatibility; corrected before the passing build/full suite/harness. No tests weakened.
- Final checks passed: backend governance baseline, architecture, both changed JavaScript syntax checks, governance frozen baseline and cross-repository consistency, all 21 governance safeguard tests, and git diff --check in both repositories.

## Handoff

Card checklist 1–5 complete: exact marking, safe propagation, UI state, tests and evidence. Implemented and locally tested only; not deployed or live-demonstrated. The original live failure cause and historical session cleanup remain unresolved. Owner controls any future image/live execution approval; implementer must present the concrete bounded next proposal first. No consumed operation replay, cloud query, provider request, runtime change or hold release occurred.

Existing 2B; P06 12/14, R11/full R12 open; accepted 1A/1B/2A remain 3/8. No scope deviation.
