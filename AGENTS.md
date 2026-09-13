# Signmons execution safeguards

These repository instructions apply to all Signmons work. The owner requested them to stop invented work and rolling scope. They supplement, not replace, the current ticket and approval boundaries.

## Read before work
For controls-only main before feature adoption, read the frozen plan under governance docs/execution-baseline; do not infer that stale main pointers authorize restarting old tickets. If current canonical documents are unavailable, stop and resolve the focused approved checkpoint.
Read the governance GLOBAL_EXECUTION_POINTER.md, EXECUTION_BOARD.md, SESSION_HANDOFF.md, active ticket, relevant DATA_CONTRACTS.md sections and APP013_REMAINING_EXECUTION_CONTRACT.md. Resolve the saved backend and related governance repositories; inspect current branches, evidence and user changes. Do not infer the active ticket from historical conversations. Preserve unrelated changes; use the existing focused worktrees when saved checkouts are dirty. Keep Eternity website/marketing out of scope.

## Requirement traceability before coding
For every change state the approved section ID, exact acceptance criterion, inspected source/evidence of the missing behavior, and how this advances the connected customer workflow. If any is missing, do not implement it. Do not treat a newly written plan as prior authority.

Complete the current section card before coding: source SHA; existing components/tests to reuse; exact behavior and expected files/interfaces; end-to-end data/state/identity/retention boundaries; finite task checklist; positive/negative/concurrency/recovery/browser tests and commands; dependencies/approval owners; exclusions; rollback/disabled state; observable finish and evidence. Material uncertainty means resolve the smallest decision or report the blocker, not build another demo.

## Frozen baseline and change control
The existing remaining walkthrough is 2B -> 3A -> 3B -> 3C -> 3D. Accepted 1A/1B/2A are not reset. Correction screens/helpers are internal 2B work, not acceptance sections. For future tickets use the owner-approved queue; do not promote a ticket before its predecessor's full acceptance.

Do not change scope, dependencies, section IDs/counts, acceptance criteria or substantial prerequisites without explicit owner approval BEFORE implementation. A new subsystem or material task-list expansion requires a change request recording the demonstrated gap, alternatives, proposed change, impact on dependencies/count/effort, and the actual owner decision. Never invent approval, silently rebaseline a check, weaken tests, or rewrite documents afterward to justify work already done. Routine work within a complete approved card does not require asking the owner to select every commit/function.

Run the governance frozen-baseline check and complete consistency check before and after governed changes. A failing baseline check is a STOP, not permission to update the anchor. Rebaselining requires a dedicated owner-approved change record and review of the old/new protected text. No bypass flag or self-approval. GitHub branch protection/required human review is a separate repository-admin control; do not claim local checks enforce it.

## Evidence, reporting and stop rules
A helper, fixture, temporary screen or passing test is not a completed customer capability. Reuse existing seams; finish the same connected journey. No substitute offline work when externally blocked unless the owner approves a specific bounded purpose.

Every handoff reports section ID, checklist items completed/remaining, blocker and responsible role, next observable result, evidence/commit, and accepted milestones. Distinguish implemented, locally tested, live-demonstrated, and owner-accepted. Percentages change only against the recorded acceptance denominator; never convert walkthrough milestones into overall MVP progress or count tests/commits as acceptance.

Every handoff includes either **No scope deviation** or an explicit deviation proposal. Propose deviations before implementation. If unintended drift is found, stop, disclose it and seek direction; do not retrospectively claim no deviation.

No merge, deployment, production migration, IAM/secrets/provider configuration, billing/charges, customer contact/data/appointments, or training without the required explicit approval. Planning/implementation approval does not imply external action approval. Do not automatically rerun paid tests or reset cost holds.

## Required checks
Run `node scripts/execution-controls-check.mjs`. Do not change the pinned baseline merely to pass. GitHub requires @Debynyhan code-owner review; never submit an approval as that account on the owner's behalf.

## Existing project checks
Run the current governance docs-consistency check and any existing alignment/placement checks; use the resolved backend path for cross-repository checks when supported. Required product gates come from the approved section card. Do not run a nonexistent script or weaken this guard to work around unavailable history. Run git diff --check in both repositories. For controls-only work, test this guard and existing governance checks; no runtime/browser acceptance is claimed.
