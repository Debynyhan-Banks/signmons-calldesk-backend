# P06/R11 enabled20 correction-selection repair card

## Approved requirement and demonstrated gap

- Section: APP-013/2B, existing accepted sequence unchanged.
- Criterion: the approved remaining-execution contract requires that correction selection update the protected draft/revision, while revalidation remains an explicit action and no provider result is silently adopted.
- Source: backend `bd8d9cf` with coordinator policy commit `b01673b`; governance `1089e27` before reconciliation.
- Live evidence: consumed plan `4be1b8c1-6c55-4190-aff9-272d2bb9179f` reached phone verification and returned a valid standardized address suggestion. The enabled20 page displayed that suggestion as text only and required manual re-entry. The owner ended the journey before a corrected second preview/submit. Closeout is verified `CLOSED` with no failures. No successful job receipt exists.
- Missing behavior: the integrated protected page has no explicit control that copies the validated suggestion into the editable address fields. This leaves the approved correction-selection path incomplete and caused the connected workflow to stop at correction.

## Connected behavior and boundaries

Add one explicit **Use suggested address** control to the existing controlled-address form. A valid `CORRECTION_REQUIRED` response may make the control available. Selecting it copies the allowlisted candidate street/unit/city/ZIP into the existing customer-visible fields and updates only browser memory. The customer must still review the fields, check the existing review acknowledgment, preview the draft and explicitly submit again. Selection does not call a provider, verify the address, create a job, book, charge, dispatch or send anything.

The candidate stays in memory only and clears with the private session. The server remains authoritative: the second submit creates a new request ID, repeats guarded address validation using the retained correction chain and admits only if current phone, address, coverage, tenant and policy evidence pass. Malformed or overlong candidates remain unselectable and fail closed. Manual editing remains available.

Expected files/interfaces:

- `scripts/fixtures/customer-intake-journey.html`: one controlled-address selection button.
- `scripts/fixtures/customer-intake-journey.js`: bounded in-memory candidate, explicit selection handler and lifecycle clearing.
- `scripts/verify-controlled-intake-ui.mjs`: browser proof that selection copies all fields including unit and ZIP+4, does not submit automatically and the second explicit submit uses the selected address.
- Existing connected/disposable-browser checks: switch the correction path from manual retyping to the explicit control without changing transport or admission APIs.

## Finite checklist and exit evidence

1. Add the hidden-by-default explicit selection control and clear its candidate with session state. Exit: no candidate means no usable control.
2. Bind only a validated `CORRECTION_REQUIRED` projection; reject candidates that cannot fit the existing structured fields. Exit: no truncation or hidden adoption.
3. On click, copy the candidate into visible fields, invalidate prior review state and require the existing preview plus submit actions. Exit: zero network requests occur on selection.
4. Update focused UI and connected-browser tests for positive selection, unit/ZIP+4 preservation, manual-edit availability, second request identity and exactly one eventual job in synthetic/disposable acceptance.
5. Run focused tests, full applicable backend gates, governance baseline/consistency checks and `git diff --check` in both repositories.

Negative/recovery cases: absent or malformed candidate, overlong structured part, session clear/reload, editing after selection, no automatic provider call or submit, truthful correction on the first submit, and unchanged uncertain-outcome exact-retry behavior. Concurrency and database admission remain covered by the existing connected harness because this repair adds no server write or operation identity.

Dependencies and authority: the existing APP-013/2B card and its correction-selection criterion authorize this local repair. A future provider request, verification code, packet, LOGIN, activation, deployment or connected browser run requires fresh separate approval. No current live action is authorized.

Rollback/disabled state: remove the button and candidate-selection logic; controlled intake remains disabled unless separately activated. No migration, configuration, secret, IAM or provider change exists.

Observable finish: local browser evidence shows one explicit selection copies the suggested address, then a separate preview and submit reaches the existing truthful admitted/refused/correction/uncertain handling. P06 remains 12/14 until a separately approved connected journey produces correlated acceptance evidence. No scope deviation.

## Implemented result

The existing controlled page now exposes **Use suggested address** only after a structurally valid correction candidate fits the page's street/unit/city/ZIP bounds. Clicking it copies the candidate into the visible fields, invalidates any prior review and performs no request. The customer must separately acknowledge review, preview the draft and explicitly submit. The candidate is memory-only and clears with the private session. An overlong candidate keeps the control unavailable; manual entry remains possible.

Validation completed locally with fictional data only:

- focused Jest: 3 suites / 120 tests passed;
- full Jest: 129 suites / 2,360 tests passed, with one existing skipped suite / three skipped tests;
- lint, build, architecture and syntax checks passed;
- mocked browser matrix: 14 mobile/desktop cases passed, including unit and ZIP+4 copying, no request on selection, eventual explicit second submit and an unselectable overlong candidate;
- guarded connected PostgreSQL 18/browser harness passed all 26 migrations, restricted runtime-role checks and eight loaded 390/1440 browser scenarios. Its correction cases used the explicit selection, performed exactly two synthetic address calls and created exactly one fictional job after the second explicit submit;
- provider calls, live actions and real job writes were zero. The owned PostgreSQL 18 cluster and disposable database were stopped/removed by the harness. The initial default-socket harness run correctly refused local PostgreSQL 16 before the loaded browser cases and cleaned up its disposable database.

Ephemeral review artifacts: `/private/tmp/signmons-r11-correction-selection-ui` and `/private/tmp/signmons-r11-correction-selection-connected-pg18`. These are synthetic local evidence, not staging acceptance. No packet, credential, provider request, LOGIN, activation, deployment or live browser action occurred during this repair.
