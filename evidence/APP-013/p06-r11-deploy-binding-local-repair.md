# APP-013/P06 R11 deployment-binding local repair

## Authority and result — 2026-09-21

The owner approved `APP013_P06_R11_DEPLOY_BINDING_CHANGE_REQUEST.md` alternative 1 for local repair and testing only. Backend commit `33d7735` completes that bounded repair. No private packet, LOGIN, database operation, activation, deployment, provider request, verification code, browser/customer action, secret/IAM change, billing change or live execution occurred.

## Implemented behavior

- `deriveR10CloudRunRevisionSuffix` derives the only accepted Cloud Run suffix from the exact reviewed full revision; it cannot inherit a prior packet's shorter literal.
- `reviewR10CloudRunRevisionSuffix` fails closed at `DEPLOYMENT_BINDING` unless a helper's candidate suffix exactly matches that derivation. Future private helpers must use this seam during no-action review and use the derived value for deployment.
- Closeout now accepts an already-`REVOKED` approval only when both runtime and phone digests match the reviewed plan. It skips a second revoke and retains tag removal, runtime-role shutdown and final closed-state readback. A foreign or mismatched revoked approval remains `APPROVAL_UNCONFIRMED`.
- Packet schema, activation/deployment order, one-use reservations, zero-traffic and baseline requirements, no-retry behavior and final readback are unchanged.

## Validation

- Focused controller/runtime packet suites: 33/33 pass. New cases cover exact suffix derivation, stale suffix refusal, matching revoked closeout and mismatched revoked refusal; existing activation, deployment, containment, concurrency and window tests remain green.
- A read-only local fixture extracted the consumed enabled14 helper's actual `enabled13` command suffix and returned `R11_DEPLOYMENT_BINDING_FIXTURE_REJECTED_STALE_SUFFIX` before any action.
- Prettier check, lint, build/Prisma generation, architecture, backend governance/consistency and whitespace checks pass.
- Governance frozen baseline, cross-repository consistency and all 21 governance regressions pass.
- Full application Jest was not rerun because this operator controller is not imported by the application runtime; build/lint and the complete controller/runtime-packet suites cover the changed boundary.

## Handoff

The local defect is repaired, but R11 and full R12 remain open and P06 remains 12/14. The consumed enabled14 plan, commands and one-packet phone-ceiling allowance remain unusable. A future attempt requires a new owner-selected window, separately authorized read-only provider/target/policy/participant/liability refresh and packet preparation, including a fresh ceiling decision, followed by separate exact execution approval. No live authority is inherited.

No scope deviation beyond approved alternative 1.
