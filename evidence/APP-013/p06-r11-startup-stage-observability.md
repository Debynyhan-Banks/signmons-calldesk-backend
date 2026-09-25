# P06-R11 local startup-stage observability — 2026-09-25

Section: APP-013/2B, P06-R11. Owner approved alternative 1 in governance `APP013_P06_R11_STARTUP_STAGE_OBSERVABILITY_CHANGE_REQUEST.md` for local implementation and testing only. Starting backend ed6c20de479fc4895377e614780d89dc76ee5ab2; governance 963f9869cfd32cf378fd408d9c9cce1e0b2f25fd. Both focused worktrees were clean; original APP-010 checkout and consumed private operations were untouched.

## Requirement and demonstrated gap

The existing connected-workflow criterion remains a protected phone/address/reviewed-draft journey admitting exactly one controlled job. Enabled27 failed before serving that journey. Its approved historical diagnostic returned only generic startup/bootstrap/listener failures; the source discarded the failing stage. This change adds safe evidence for a future separately authorized startup. It does not establish or repair enabled27's original underlying cause.

## Implemented behavior

- Thirteen fixed startup stages cover configuration, injected material, packaged assets, resource construction/loading, runtime configuration/resources/approval/key material/services/authority/binding, and registration.
- An internal WeakMap carries only a fixed stage through the existing sanitized exceptions. Public bodies/messages do not gain fields or raw causes. No identifiers, paths, configuration, keys, SQL, phone/address/email or original error text are emitted by the diagnostic.
- Main records once in its existing pre-listener failure catch, through LoggingService. The fixed event is `CONTROLLED_INTAKE_STARTUP_FAILURE stage=<allowlisted-stage>`.
- Real Nest buffering initially hid the warning. The final recorder synchronously detaches the known startup buffer for this warning only, restores buffering in finally, and catches logger failure. It does not flush unrelated queued initialization logs. Application close/refusal and key-buffer zeroization remain enforced; registration failure attempts runtime retirement even when cleanup itself fails.
- Disabled and successful startup paths gain no diagnostic output or provider work. Existing identity, policy, expiry, current authority, budget and activation checks are unchanged. No schema, dependency, API, UI, sink or retention change.

## Local validation

| Check | Result |
| --- | --- |
| Three focused startup/runtime/diagnostic suites | 56 tests passed |
| Full Jest regression | 131 suites / 2,400 tests passed; existing 1 suite / 3 tests skipped |
| Lint, local Nest build, architecture, Prisma schema validation | Passed |
| Existing disposable PostgreSQL 18 / local browser regression | Passed through final operator-admission and browser-review assertions |
| Governance baseline, cross-repository documentation, 21 safeguards, both whitespace checks | Passed |
| Independent code/privacy/cleanup and fixture review | Clear after the buffer correction |

Focused coverage includes every fixed stage, original public responses, unmarked/forged/primitive errors, secret-bearing errors with inaccessible causes, retirement/zeroization, and actual LoggingService → Nest → ConsoleLogger buffering. A throwing sink still restores buffering and reaches close/refusal. Actual disposable loader checks retain the real approval reader and authority transactions, verify stage classification for refused approval/key material, and preserve zero startup provider calls, revocation and retirement refusal.

The initial sandboxed full Jest run could not bind test servers (`listen EPERM`). The authorized local-network run passed; no test was weakened. Logs are retained under `/private/tmp/signmons-startup-stage-checks-bufWzn`.

The first disposable run passed the actual loader and all eight loaded-browser cases, then exposed a pre-existing legacy fixture mismatch: it preprovisioned phone proof but omitted the browser verification port and code-check steps, while the current UI correctly disabled Preview. Those fixture/UI files matched pre-change runtime 6d8ba54. The pinned card recorded the gap before a test-only correction to the two existing fixture scripts. Browser cases now use the real ControlledCustomerVerification/durable service, current authority/session lock, and explicit NOTICE/START/CHECK before Preview; service-only cases and every prior assertion remain. No synthetic verified browser state or guard bypass was added. Exactly two synthetic phone calls per legacy browser case are asserted.

Final full disposable evidence: `/private/tmp/signmons-runtime-role-kG5Nc4/harness.log` and `evidence/`. All eight actual loaded-browser cases (accepted/outside/unknown/correction at 390/1440), all eight legacy connected-browser cases, receipt replay, concurrent admission, rollback, revocation, retained holds, browser privacy and subsequent operator/browser-review assertions passed with synthetic provider ports only. Cleanup readback is `0|0` (test databases/runtime roles); `final-status.log` confirms no server running. The earlier fixture-failure cluster `/private/tmp/signmons-runtime-role-1khZGP` was also verified `0|0` and stopped. Historical evidence is preserved.

## Handoff

Local checklist items 1–6 are complete: source-bound card, stage implementation, focused coverage, actual disposable workflow, required checks, independent review and this handoff. Implementation and local tests are complete; this work is not live-demonstrated customer acceptance. P06 remains 12/14; R11 and full R12 remain open; accepted 1A/1B/2A are unchanged.

Blocker: the original enabled27 startup gate remains unknown. Implementer owns any next concrete repair-image decision; owner separately authorizes its bounded build/window and any later refreshed execution packet. The next observable live result would be either successful startup or a fixed failing-stage record, only after that separate authority exists. No owner Terminal command is needed for this local repair.

No image build, packet preparation, live database/LOGIN, activation, deployment, provider request/code, browser/customer action, hold release, secret/IAM or billing change occurred. Prior verified shutdown remains the last runtime evidence. Do not rerun consumed operations. No scope deviation.
