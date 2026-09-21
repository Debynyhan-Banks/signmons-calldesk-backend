# P06 / R11 one-command attended coordinator

## Authority and result — 2026-09-21

The owner approved `APP013_P06_R11_EXECUTION_EFFICIENCY_CHANGE_REQUEST.md` alternative 1 for local implementation and testing, plus policy authority for exactly one future R11 packet with `flowUpperBoundMicros: 500000` and `accountCeilingMicros: 2500000` while preserving all four existing holds. Packet preparation, LOGIN, database mutation, activation, deployment, provider requests, verification codes, browser/customer action, hold release, secret/IAM change, billing change and live execution were expressly excluded.

Local implementation is complete from entry backend `be624c1` and governance `8a36139`. Added only:

- `scripts/p06_r11_attended_coordinator.py`
- `scripts/test_p06_r11_attended_coordinator.py`
- this evidence

No application route, schema, migration, dependency, image, private packet or external resource changed. No private participant value or credential was read. No database, Cloud Run, Twilio, Google Address, browser or secret-store request occurred.

## Implemented boundary

- The reusable command accepts only `--run <absolute private packet directory>` from an attended TTY. It has no database, Cloud, provider or browser implementation; it invokes the future packet's reviewed `r10-control.mjs` modes.
- Local review requires the canonical private-directory pattern, owner-only directory/file modes, matching plan/approval/window values, one run, automatic retry disabled, a clean bound source commit, exact helper hashes, and no prior coordinator/controller action or stop marker.
- The future packet is additionally locked to the approved four holds / 2,000,000 retained micros, a 500,000-micro flow and 2,500,000-micro account ceiling. A future `helper-binding.json` must hash this coordinator together with the exact private controller and existing R10/runtime-packet modules.
- Early invocation waits locally before any controller call. At the database window it calls `--check` once, writes one exclusive mode-0600 coordinator attempt marker, prompts once through the existing hidden TTY reader, calls `--open-login` once, waits locally for runtime start, then calls `--run` once.
- Exact child `READY` framing is required before the same mutable password byte array is forwarded through anonymous stdin. The value is never placed in arguments, environment, files or output and is overwritten on every coordinator exit.
- Only the exact reviewed `/customer-intake` URL is printed. The browser stays owner-operated. The coordinator accepts local `DONE` or `STOP`, treats browser deadline/interrupt/child failure as a stop, and funnels every possibly started live sequence through one `--closeout` invocation. No child mode is retried.
- Exact controller outputs are required: no-action check, LOGIN opened, active controlled URL and verified R12 closeout. An absent verified closeout returns a distinct unconfirmed result. Existing activation/deployment reservations, zero-traffic checks, revocation order, runtime disablement and final readback remain unchanged.

## Validation

- Python coordinator/private-input suite: 24/24 pass. It covers early waiting with no action, exact ordering, one prompt, exact policy/window/helper binding, mode-0600 exclusive marker and reuse refusal, wrong ceiling/hash refusal, open/run failure closeout, no retry, browser interruption, browser deadline closeout, closeout uncertainty and password zeroization. A real subprocess protocol fixture proves complete `READY` framing and no secret output.
- Existing R10 controller regression: 24/24 pass, including at-most-once activation/deployment, containment order, ambiguous-result handling and marker reuse refusal.
- Full backend Jest outside the restricted listener sandbox: 129 suites pass, one existing suite skipped; 2,360 tests pass, three existing tests skipped. The first sandbox run failed only because localhost listeners were denied (`EPERM`); the unchanged suite then passed with local loopback access.
- Build, lint and architecture checks pass. Backend governance and whitespace checks are included in final synchronized verification.

## Handoff

This is locally implemented and tested; it is not a packet or live R11 evidence. P06 remains 12/14 with R11 and full R12 open. The approved one-future-packet ceiling policy remains unused. Next is one owner-selected future window, current read-only provider/target/policy/participant/liability qualification, a fresh exact packet binding this helper and the approved ceiling, packet review, then separate exact execution approval. The intended owner interaction after that approval is one Terminal command, one browser journey and one final result report.

Approved execution-process deviation only; no other scope deviation.
