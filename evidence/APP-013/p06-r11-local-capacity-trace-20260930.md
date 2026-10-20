# APP-013 / 2B / P06-R11 local capacity trace result — September 30, 2026

Owner authorized bounded local investigation; card APP013_P06_R11_LOCAL_CAPACITY_TRACE_20260930.md preceded edits. Application source unchanged at diagnosticfe9b066 within backend3cf8a9d. Only scripts/verify-loaded-intake-browser.mjs extended; prior evidence/tmp/design edits preserved.

## Findings proved locally

Existing previewDraft and controlled UI preview reserve no address operation and make no address-provider request. Four fictional historical account/tenant holds remain four after preview. Direct submission creates one synthetic job using one operation; injected lost acknowledgment followed by exact retry returns the same receipt with no extra provider call.

A supported correction sequence uses two distinct submit/intent IDs. First submit returns CORRECTION_REQUIRED with no job and a fifth aggregate operation. Copying the suggestion and previewing again adds no operation. Explicit corrected submission uses the sixth aggregate operation and creates one job. Two-operation session and six-operation aggregate limits are sufficient for this ordinary tested correction sequence.

With six fictional historical operations already held in another session, preview remains read-only, explicit submit returns UNCERTAIN/jobCreatedfalse with the exact “Outcome unconfirmed” UI, zero address-provider calls and zero new job. Same-request retry returns the identical receipt; six operations/USD0.60 remain unchanged. Edit remains disabled and no alternative request is started. This reproduces the live message and zero new intent/job pattern, but does not prove the live failed guard.

All five modes (accepted/outside/unknown/correction/capacity) pass at390 and1440 widths:10loaded browser cases. Synthetic providers only; all real network services excluded. Four retained holds/100000micros each added to the positive cases to model the prior aggregate baseline. This is stronger retained-liability coverage, not a changed production budget. Existing outside/unknown/lost-ack and session-close checks remain. Capacity follows existing uncertain-screen cleanup behavior; no live payload cleanup conclusion follows.

## Validation and evidence

176focused tests in four existing suites passed: address executor, address ledger, controlled verification, intake continuation. npm run build passed. node --check scripts/verify-loaded-intake-browser.mjs passed. Complete existing verify-organization-profile.mjs disposable database/browser harness passed with PLAYWRIGHT_MODULE explicitly bound to the installed runtime and ORGANIZATION_SOCKET_DIR to a fresh private socket. Successful artifacts: /private/tmp/r11-capacity-evidence-313d44884811/harness.log and loaded-{mode}-{390,1440}.png. Harness exit0; post-run database count0; owned TCP-disabled PostgreSQL18 cluster stopped and removed. Build generated only existing ignored outputs; no runtime/app source edit. Backend governance/architecture and governance frozen/consistency/21safeguards/whitespace checks pass.

Two local preparation failures retained: first lacked required PLAYWRIGHT_MODULE (/private/tmp/r11-capacity-evidence-102bffba6c12); second synthetic OBSERVED historical rows lacked required attemptId (/private/tmp/r11-capacity-evidence-ce003d1f60b3). Corrected invocation and fictional row fields; no guard/constraint removed. Both verified zero disposable databases and removed owned clusters. No consumed live operation was rerun. Real SQL constraint coverage caught the fixture error.

## Conclusion and remaining limit

Reject the hypothesis that preview itself spends address allowance. Capacity exhaustion can reproduce the message, but snapshot aggregates cannot attribute the two new live operations to this participant, identify their individual outcomes, or establish the cap at the exact final-submit time. Current executor catches reserve/claim failure as generic UNCERTAIN, so this message cannot distinguish definite pre-dispatch refusal from an uncertain provider/commit result. Raising limits, repeating the live journey or asserting a provider outage is not justified.

Investigation checklist1–5 complete. Recommended next decision is a bounded change proposal for truthful pre-dispatch refusal classification and exact-request recovery guidance, preserving all limits and uncertainty after dispatch/commit. Do not implement that behavior change under this test-only approval. Any live correlation of the earlier operations/session needs a separately scoped read and must not reset holds. R11/fullR12 remain open;P06 stays12/14;accepted1A/1B/2A remain3/8. No scope deviation.
