# P06 / R10 reviewed-plan composition repair

## Approved section and demonstrated gap

Section APP-013/P06/R10 remains open. Its existing criterion requires one exact activate-before-deploy run and ordered closeout. After the verified 7:01 AM recovery, the owner said `proceed` for the next recorded step: local helper/controller repair and testing only. No external action or fresh packet/window is included.

The 7:01 AM closeout stopped at controller stage `PLAN` because the private helper passed `reviewR10ControllerPlan()`'s enriched return value into `closeR10Runtime()`. The public reviewer returned three derived enumerable keys, while every downstream entry point correctly required the original exact plan schema. This was a demonstrated interface-composition gap in the otherwise tested local controller.

## Change

- `reviewR10ControllerPlan()` now returns a frozen copy containing exactly the eleven approved plan fields after performing the same strict validation.
- Execution and closeout window guards derive their millisecond comparisons from the already validated ISO fields rather than attaching enumerable derived fields.
- Regression coverage asserts that reviewer output has the exact input keys and passes that reviewed output directly into both the successful activate-before-deploy path and inactive explicit closeout path.
- Strict rejection of unknown input keys, consumed plan/revision, invalid windows and all existing at-most-once/ordered-containment behavior remains unchanged.

This advances the connected workflow by removing the exact local composition failure before any future helper is prepared. The controller remains inert, has no CLI, and imports no live database, Cloud or provider client.

## Validation

- 21 focused controller tests passed, including the reviewed-plan execution and closeout regressions.
- All 77 P06 Node tests passed with two expected local-PG skips.
- Full Jest: 2,359 passed, three skipped, zero failed. The sandboxed first run was unable to bind loopback test servers; the same suite passed with local loopback permission.
- Build, lint, architecture and Prisma validation passed.
- Required frozen-baseline, cross-repository consistency and whitespace checks pass after synchronized evidence.

No provider/target refresh, encrypted participant/bundle access, packet, helper installation, LOGIN, activation, deployment, verification request, Address Validation request, customer action, secret/IAM change or traffic change occurred. The recovered inactive state remains authoritative. P06 remains 11/14; R10/R11/R12 remain open.

Next observable result requires an owner-selected future attended block and explicit authorization for current read-only provider/target refresh plus fresh packet preparation. Execution remains a separate exact approval. Original dirty APP-010 checkout preserved. No scope deviation.
