# APP-013 / 2B / P06-R11 — refusal-category repair locally complete

The owner explicitly approved the four-category local diagnostic repair and listed tests after reviewing governance `APP013_P06_R11_ENABLED33_REFUSAL_DIAGNOSTIC_DECISION_20261002.md`. This remains internal 2B work: an invalid or unconfirmed address keeps the draft and cannot create a job, while the browser now receives a finite actionable category. No admission, coverage, correction, retry, budget, retention or authority rule was loosened.

Implemented on the existing focused backend worktree while preserving prior P06/R11 changes:

- `controlled-intake-verification.service.ts` identifies `ADDRESS_REVIEW_UNAVAILABLE`, `SERVICE_AREA_NOT_CONFIRMED`, `OUTSIDE_SERVICE_AREA` and `ADDRESS_CORRECTION_STATE_UNAVAILABLE` at the branch where the cause is known.
- `controlled-intake-browser-result.ts` projects only those four categories plus the existing `VERIFICATION_LIMIT_REACHED`; untrusted or contradictory categories fail closed. Provider payloads, county values, response identifiers and internal policy data remain absent.
- `customer-intake-journey.js` retains the draft, clears stale reviewed state and gives category-specific guidance. Existing admitted, correction-required, uncertain and verification-limit behavior remains.
- Service/projection and mobile/desktop browser regressions cover each new category, invalid categories, accepted/correction/uncertain paths, retained fields and zero browser storage.

Final file SHA256 values:

- verification service `b5559b35ecbe48002c2cdd7589f2503d84a0a2d2a3c9c2ac0e0c1e744ece801b`
- browser projection `1bdce8e5817b99c42dc20a1811affd97dbc905daec6f7b2192540a2313f05db0`
- verification spec `34861fc59f90e349e8ead774e0977c65381aaa7e5006e679a95b7a17ffa21d53`
- projection spec `ac3110f61a837a5ebb8196c6631f29677a47937217e361b43289efefd3d2161f`
- journey browser script `d0d5fdbcebd46547d5524248926d614fc1152fa86a2f0d4d5a94960c6508eec8`
- UI verifier `96e0cff33ad1c30e486554bf697380496966bd8ecf371eab5655a9291bf70b7f`

Validation:

- focused verification/projection/transport: 136 tests passed;
- full Jest: 2,486 passed, three existing skips, 132 suites passed and one skipped;
- mock-only browser: 46 cases passed at 390 and 1440 widths, zero provider calls and zero job writes; artifacts `/private/tmp/r11-refusal-category-ui.80BjHB`;
- complete disposable PostgreSQL 18/database/browser harness passed accepted, outside, unknown, correction, format-correction, repeated-correction and capacity cases at both widths, plus restricted-role and operator flows; zero live provider calls; artifacts `/private/tmp/r11-refusal-category-pg18-db.sAAMxL`;
- lint, build, architecture, syntax and Prettier checks passed.

The first full Jest attempt in the restricted sandbox failed only where HTTP fixtures could not bind loopback ports; the approved local-only rerun passed. The first disposable harness used the default PostgreSQL 16 socket, cleaned its fixture and stopped at the intentional PostgreSQL 18 guard. A private socket-only PostgreSQL 18 cluster with TCP disabled then passed the complete harness; its fixture database was removed, the server stopped and its cluster directory deleted.

No staging/cloud query, live provider action, paid request, build publication, deployment, database migration or runtime configuration change occurred. The prior enabled33 package remains consumed and closed. Local repair checklist is complete. Remaining: source-bound release proposal/approval, any separately approved live journey and R11 owner acceptance. P06 remains 12/14; R11/full R12 remain open; accepted 1A/1B/2A remain 3/8. No scope deviation from the expressly approved local repair.
