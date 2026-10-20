# P06/R11 preview-readiness UI repair

Section: APP-013 / 2B / P06-R11. Authority: owner-approved Alternative 1 in governance `APP013_P06_R11_PREVIEW_READINESS_UI_DECISION_20261002.md`. Acceptance: make the current preview blocker and private-session deadline HTML-visible while retaining the exact fail-closed enablement gate.

## Implementation

Only the approved three files were changed for this repair:

- `scripts/fixtures/customer-intake-journey.html` adds an HTML-visible `role=status` readiness line beside **Preview validated draft**.
- `scripts/fixtures/customer-intake-journey.js` projects one current state: session expired, request processing, prior outcome pending, phone check required, review acknowledgement required, or ready. It displays the private-session expiration time and a final-90-second warning. The existing button-disabled expression is unchanged.
- `scripts/verify-controlled-intake-ui.mjs` adds mocked processing, pending-draft, final-90-second and expired-session coverage, plus readiness transitions.

No admission/job rule, verification/provider operation, retry/resend, address/service-area policy, budget/ceiling, database/schema, retention, authentication or server-owned authority changed. Existing unrelated working-tree changes were preserved. Backend HEAD at validation was `3cf8a9dc53d0282a35e6263a36d749c5b32f8e2e`; because the focused recovery checkout is intentionally dirty, this is local implementation evidence rather than a release commit.

Validated file hashes:

- HTML `0104cafb3473cdc140b7a652cf7573000714d12e57ffe24e7c594eb864922384`
- browser JavaScript `3936b31fa9e4a2ca136140ef56a2686efcdc1723c6738bf7b9fd5854ae513ba5`
- mock browser verifier `1d21ac7a849b8a4a3ec5c768869fcf8338f00ee78ce4d907967c75647fd9dac9`

## Validation

- Mock-only Playwright: 50/50 cases passed at 390px and 1440px. New cases cover delayed preview (`busy`), retained uncertain draft (`pending`), final-90-second warning, expired session, missing phone acceptance, missing review acknowledgement and ready state. Existing admission, correction, categorized refusal, uncertainty, duplicate-click, phone refusal/change/end, privacy clearing and responsive checks still pass. Artifact: `/private/tmp/r11-preview-readiness-ui-20261002-r2/summary.json`; `realProviderCalls:0`, `actualJobWrites:0`.
- Safari-specific local fixture with the exact updated assets visibly showed the locked phone-check reason/deadline, then **Ready to preview: phone accepted and details reviewed** and an enabled preview button after synthetic code acceptance plus review acknowledgement. Fixture receipt: `/private/tmp/r11-preview-readiness-safari-20261002/serve-summary.json`; start1, continue1, synthetic verify2, submission0, errors[], real provider calls0, job writes0.
- Focused same-origin asset Jest: 3/3 passed.
- Full Jest: 132 suites passed, one skipped; 2,486 tests passed, three existing skips.
- ESLint, build, Prisma generation, architecture, JavaScript syntax, Prettier and backend whitespace checks passed.
- Required governance frozen-baseline, consistency, 21 safeguard tests and both repository whitespace checks pass after reconciliation.

The initial sandboxed full Jest invocation was stopped after local server binds returned `EPERM`; the same full command passed outside that network-isolated sandbox with loopback-only permission. No external network or live service was used.

## Handoff

Local implementation and validation are complete. The next observable result is a source-bound release proposal that first reconciles post-enabled34 liability and exact target state; no build, deployment, database read, provider request, message, ceiling increase, browser journey or job action is authorized by this repair. Enabled34 remains consumed and `CLOSED`; current liabilities and job state remain unknown. P06 remains 12/14; R11/full R12 remain open; accepted 1A/1B/2A remain 3/8. No scope deviation from the approved local UI repair.
