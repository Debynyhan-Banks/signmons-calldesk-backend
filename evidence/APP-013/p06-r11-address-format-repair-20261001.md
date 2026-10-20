# APP-013 / 2B / P06-R11 — local address-format repair

Status: implemented and locally verified October 1, 2026; not deployed or live-accepted. Owner replied "yes i approve" to exact ZIP assembly plus twelve suffix pairs and the finite local tests in governance APP013_P06_R11_ADDRESS_FORMAT_DECISION_20261001.md. This advances the existing customer-reviewed single-job criterion; no new section or paid attempt.

## Exact change and preserved boundaries

Only runtime change: src/communications/google-address.adapter.ts. Assemble confirmed ZIP5 plus four-digit suffix; check an already complete ZIP+4 against any separately supplied suffix. Malformed components or contradictory complete/suffix evidence refuse. Customer ZIP, postal ZIP and assembled structured ZIP must agree before REVIEW.

The twelve approved suffix pairs apply only to the final street token, with identical preceding house-number/name tokens and at least one route-name token. Customer input must still match the postal candidate after the existing case/whitespace normalization. No internal name/direction/unit expansion, punctuation removal, guessed suffix or unlisted alias. Required components, flags, unit/granularity/DPV, physical-address/county, current phone/tenant/session/revision/policy and durable observation/uncertainty checks are unchanged. Parser review alone grants no authority. The preceding local correction-limit repair remains in place.

Changed tests: google-address.adapter.spec.ts, google-service-area.spec.ts and scripts/verify-loaded-intake-browser.mjs. No service, production UI, storage/interface/schema/provider or admission-transaction change. No retained raw provider content. Existing holds/caps and consumed runtime snapshots are untouched.

Backend HEAD 3cf8a9dc53d0282a35e6263a36d749c5b32f8e2e plus pre-existing focused-worktree changes; governance HEAD 8d7c644ecc8e65ec139bcfcc3fef055ad5d423cd plus existing changes. No commit, merge, image build/upload or release performed. Pre-edit copies: /private/tmp/r11-address-format-before-20261001. Four-file isolated delta: /private/tmp/r11-address-format-patch-20261001.diff; SHA256 d57d57cfbc6dfc6ca661dc00b8eb6cd4da9fc698b698d98d123e074a4e24e5e3. Per-file before/after hashes: pre-edit directory manifest.json. The copied controlled-intake-verification.service.spec.ts is unchanged.

## Fresh local validation

- Regression before runtime edit: 17 failed / 85 passed, demonstrating missing supported-format behavior. After edit: adapter 102/102; service-area 51/51. Tests preserve exact postal confirmation, genuine conflicts, malformed/duplicate/unconfirmed/inferred suffixes, unit handling and identity/county/physical-address refusals.
- Full suite: 132 suites / 2,480 tests passed; one existing skipped suite / three existing skipped tests. The first sandboxed invocation failed existing local HTTP-listener tests with listen EPERM. Re-running the same synthetic suite with local-listener permission and DATABASE_URL/DIRECT_URL unset passed; no code/test weakening was used.
- npm run lint, npm run build (local compilation), node scripts/architecture-check.mjs and browser-harness syntax check passed. Independent parser diff/card review found no material issue.
- Complete existing disposable PostgreSQL/browser harness passed, including 14 loaded cases: accepted, outside, unknown, correction, format-correction, repeated-correction and capacity, each at 390/1440 pixels.
- New format-correction case uses STREET/ST at 390 and LANE/LN at 1440, each with separate ZIP5/suffix4 components and a postal ZIP+4. Initial full-form/ZIP5 submission produces correction and no job. Copying the candidate makes no provider call and requires explicit customer review. Second submission sends the actual postal spelling/ZIP+4, creates exactly one job, and preserves the reviewed address in browser fields and the job's customer-attributable address.
- Exactly two distinct OBSERVED address operations and their holds remain in each new case. The existing repeated true-conflict case retains the draft, refuses a third submission and creates no job. Existing duplicate/concurrent/restart, lost-ack replay, rollback, stale/foreign identity and uncertainty checks also passed in the complete harness/full suite.
- Zero live provider calls. The owned socket-only temporary PostgreSQL cluster had zero remaining fixture databases, was stopped and removed. Mobile success screenshot inspected; job-created receipt correctly disclaims booking/payment authority.

Logs: /private/tmp/r11-address-format-before-20261001/red-tests.log and adapter-tests.log; /private/tmp/r11-address-format-unit-20261001.log (initial sandbox failure); /private/tmp/r11-address-format-unit-local-20261001.log (passing full suite); /private/tmp/r11-address-format-lint-20261001.log; /private/tmp/r11-address-format-build-20261001.log. Connected harness and screenshots: /private/tmp/r11-address-format-evidence-af6542f8fd37/harness.log, loaded-format-correction-390.png and loaded-format-correction-1440.png. Existing local runner was reused as /private/tmp/r11-local-address-format-20261001.py with separate evidence paths.

## Completion and remaining work

Approved local checklist 1–4 complete. Source investigation and synthetic proof establish the repaired cases; the actual live provider mismatch remains unconfirmed. Persistent inferred/replaced/spell-corrected flags and unlisted suffixes still do not auto-pass. No claim that this fixes every valid address or proves live admission.

Next observable result is a reviewable source-bound release/live-validation proposal that incorporates this patch and the prior correction-limit fix. Implementer owns that preparation; owner controls any later deployment, prospective allowance increase and attended live run. No new paid run/window or deployment package has been prepared here. Previous allowances remain exhausted at the saved snapshot; no old request or operation may be retried.

P06 remains 12/14; R11/full R12 open; accepted 1A/1B/2A remain 3/8. Local tests are not live demonstration or owner acceptance. No scope deviation from the expressly approved formatting change.
