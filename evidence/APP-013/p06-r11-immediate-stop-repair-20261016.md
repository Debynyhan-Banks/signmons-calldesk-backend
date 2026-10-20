# APP-013 / 2B / P06-R11 immediate stop reporting

## Approved card, before implementation

Owner approved the proposed bounded local repair and synthetic testing with “i approve” on October 16. No external action, charge, ceiling increase, retry, new package or deployment is authorized. This implements that decision, not a new acceptance section. No scope deviation.

Source: backend `3cf8a9dc53d0282a35e6263a36d749c5b32f8e2e`, governance `8d7c644ecc8e65ec139bcfcc3fef055ad5d423cd`, existing focused recovery branches with pre-existing mixed changes preserved. Local source snapshots and immutable package digests: `/private/tmp/r11-immediate-stop-repair-20261016`. No remote fetch in this local-only scope.

Evidence: enabled50 qualification-decision.json records PHONE_CAPACITY_INSUFFICIENT at 17:51:21Z, 21 holds / 10,500,000 micros against the same ceiling. readiness-result.json records possibleMutation=false and terminal result at 18:15Z. Archived coordinator catches the failure then waits until runtime_start in finally before returning. Its adapter discards child stderr. Thus the owner receives neither the specific capacity failure nor a prompt explanation that no link will appear.

Acceptance for this repair: immediately emit an allowlisted, sanitized stop explanation before any cleanup wait; recognize a fresh same-plan phone/address capacity refusal from the existing local qualification receipt; generic/invalid/stale evidence remains unconfirmed. Never emit raw child output or exceptions. Keep cleanup timing, attempt count, secret erasure, reservation, browser handoff and all approval gates unchanged. This advances the connected 2B journey by preventing a failed qualification from appearing to be a pending link; it does not supply job-admission evidence.

Reuse: `scripts/p06_r11_attended_coordinator.py` ProductionPorts/open_login/coordinate; existing fake-clock, exclusive-reservation, private-input and local-child tests. Expected edits: this module, its existing test file, this evidence and a short governance handoff. Do not change immutable archived source or consumed wrappers.

Boundaries: local receipt plan ID and in-invocation timestamp correlate diagnostic category only, never authorize skipped cleanup or mutation. Read a bounded regular nonsymlink receipt; allowlist capacity reasons, no raw JSON rendered. Password remains hidden/in-memory and zeroed. No new retained personal data. Existing immutable evidence remains untouched. Failure to report must not prevent cleanup.

Finite checklist:
- [x] Implement fresh bounded receipt classification and immediate failure notice.
- [x] Test exhausted capacity, unknown/stale/foreign/malformed receipts, successful readiness and failed/uncertain cleanup with fictional data.
- [x] Retain concurrency/no-retry/private-input tests; prove diagnostics precede fake-clock cleanup waits and cannot bypass cleanup on output failure.
- [x] Run focused Python tests, governance baseline/consistency/safeguard tests, architecture and both whitespace checks; verify consumed package hashes unchanged.
- [x] Record results and remaining capacity decision without preparing a new journey.

Browser: no UI change or live browser test. Existing injected DONE/STOP/TIMEOUT and local PTY browser-handoff tests cover the changed runner. Database/build/provider gates are inapplicable to this Python-only reporting repair; no application image changes. Rollback: revert only this incremental source diff against saved pre-edit bytes, retaining unrelated edits. Future executable integration needs fresh hash binding and explicit external approval; existing packages remain consumed.

Owners/dependencies: implementer owns local patch and verification; owner separately decides phone-capacity authority and any future journey. Full 2B requires correlated protected browser/request/job outcome and verified closeout. Accepted 1A/1B/2A remain unchanged; R11/full R12 remain open.

## Implemented and locally verified

The incremental repair is confined to immediate stop reporting and diagnostic receipt classification. Generic failure reporting is best effort and cannot bypass the finally closeout path. A fresh same-plan qualification receipt distinguishes phone/address capacity exhaustion; all unknown content stays private and unconfirmed. Cleanup timing is intentionally unchanged; the user is told to keep Terminal open for the scheduled cleanup check. No no-mutation shortcut or cleanup-authority change was introduced.

Validation completed:
- `PYTHONPATH=scripts python3 -B -m unittest scripts/test_p06_r11_attended_coordinator.py scripts/test_p06_r11_journey_launcher.py`: 40 passed. Includes real local child receipt/protocol, PTY hidden-input tests, success, STOP/TIMEOUT, exclusive reservation, early diagnostics, both capacity categories, malformed/oversized/symlink/FIFO/stale/foreign receipts, broken output and uncertain/failed cleanup. All data fictional; no external operations.
- Governance frozen baseline and cross-repository consistency: pass before and after edits. Governance safeguard tests: 21 passed.
- `npm run arch:check`: pass. `git diff --check` in both repositories: pass.
- Archived coordinator and all 41 enabled50 package files: SHA256 unchanged. `/private/tmp/r11-immediate-stop-repair-20261016/incremental.patch` isolates this repair from pre-existing dirty changes.

The consumed package still uses its immutable old source; this fix is source-ready, not deployed or installed into a new executable journey. No build, credentials, network/provider/database/Cloud calls, ceiling change, charge, retry or hold release occurred. No commit/push from mixed worktrees. The latest saved phone capacity remains exhausted; owner authority for any change is still required. Local checklist complete; full Section 2B acceptance remains unchanged. No scope deviation.
