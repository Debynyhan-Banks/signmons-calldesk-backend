# RV1 local verification — November 24, 2026

APP-013 / 3A / P08. Owner approved the clarified RV1 local implementation and tests in response to governance `APP013_P08_RV1_REVIEW_ADDENDUM_20261124.md` (7d9f035). The pre-code implementation card was committed at governance 069845c; backend base is 55fa194e7b6cf14cca802bbbfc05f2f1f1bc5544. This evidence records local proof only, with no external authority. Verified at 2026-11-24T09:25:35Z.

## Outcome and scope

Four existing behavioral files now carry a finite `responseValidationCode` from the existing authentication client's refused response predicate through the safe journal and exact parent merge. Direct tests are in four existing test files. The exact transformed-source guard remains enforced. One existing handoff file and ten current manifests receive derived hash updates only. `source-audit.json` pins all 19 changed files, verifies 417 file references, proves all 45 JSON changes are mapped digest-only replacements, finds no stale current source/manifest reference, and verifies all 10 tracked R56 evidence files are unchanged. Five embedded source-lock replacements are also checked by existing guards.

Codes: BODY_BOUND, JSON_PARSE, RESPONSE_SHAPE and PROVIDER_ERROR for SIGN/KEY_READ/EXCHANGE; SIGN_RESPONSE_SHAPE only for SIGN; KEY_RESPONSE_MISMATCH only for KEY_READ; EXCHANGE_RESPONSE_MISMATCH only for EXCHANGE. Codes are absent for TRANSPORT/HTTP/UNKNOWN, expired or closed post-response gates, and invalid/unrecognized diagnostics. Successful predicates clear their marker; the new diagnostic property is read once under a guard before literal allowlisting. Historical journals without a code remain readable. A malformed or misplaced code is refused before parent adoption.

The original response predicates, truthiness, duplicate JSON behavior, ordering, identity/resource checks, deadlines, no-retry behavior, cleanup, successful-authentication proof digest and payment behavior remain unchanged. `AUTH_OUTCOME_UNKNOWN` is preserved. A stopped child never gains a synthetic success digest. No raw response, token, key, URL, message or stack is retained by the new field.

## Final applicable test results

| Existing boundary / command (from its source directory) | Passed |
| --- | ---: |
| Coordinator auth: `node --test test_client.mjs` | 43 |
| Real-client binding: `node --test test_bound.mjs` | 10 |
| Real-client binding: `python3 -B -m unittest test_bound` | 19 |
| Native entry: `node --test test_connected_payment.mjs test_transports.mjs` | 57 |
| Native entry: `python3 -B -m unittest test_entry test_child_cleanup test_key_lifecycle test_private_inventory_cc1` | 148 |
| Connected packet: existing discovery with the seven inapplicable database/browser cases excluded below | 419 |

Total: 696 applicable local tests passed. The 11 journal integration tests are included in the 148 native tests, not added twice. Native tests include actual subprocess/stdout/journal/parent handling, response loss, oversized/duplicate stdout, nonzero exit, timeout and interruption, parent drift, independent cleanup, successful authentication and local synthetic payment. Native transports reject oversized bodies before the inner client sees them: those three cases retain TRANSPORT with no new code. Direct injected-client-to-journal and Python merge tests separately prove BODY_BOUND at all three stages; 12 other native stage/code combinations cross the actual assembled boundary.

The seven omitted connected cases are the five methods in `test_account_containment_read.CT3DisposableTLS` and `test_bootstrap_open.BootstrapTests.test_production_jxa_dispatches_loopback_and_closes_only_owned_window` plus `test_actual_loopback_bridge_and_headless_chrome_handoff`. Their exact IDs are printed in connected-tests.log. Native `test_native_postgres.py` is also inapplicable. No compiled app, SQL/schema or UI behavior changed, so app build/lint and database/browser drivers are not claimed as freshly validated.

## Initial failures and their resolution

Initial broad discovery exposed the connected module's embedded disposable database and browser entrypoints; sandbox restrictions stopped database initialization and the browser tests before browser dispatch. They were excluded from the host run as inapplicable. The full initial discovery was not counted as passing. Tests requiring owned-process inspection, nested process sandboxing and local listeners failed in the execution sandbox; host runs with the same injected transports passed. No provider, credential-cache, sign-in or real payment call occurred. Initial failure labels and log hashes are retained in initial-validation-results.json; full temporary logs remain at the recorded paths.

Two test expectations were corrected without changing production behavior: the intermediate work result intentionally omits childResultSha256 (final stopped result remains null); native oversized responses are refused by the existing outer transport. Independent review also caught and resolved stale marker carryover after a passed key predicate, and a changing getter that could otherwise substitute an untrusted value after validation. Regressions prove both fixes, including lone-surrogate URL construction and changing/throwing diagnostic accessors. No existing success or cleanup assertion was weakened.

## Guards, review and remaining work

Actual coordinator `verifySources`, serialized handoff `verify_sources`, real-client `verify_sources`, and native authority `verify_sources` passed. Backend governance-baseline, architecture and whitespace checks passed. Initial direct native guard import from the wrong working directory failed to resolve its local module; invocation from the actual source directory passed. Independent final review found no remaining blocking defect or out-of-scope behavior. Governance final checks are recorded in the linked completion report after canonical handoff updates.

R56's precise historical response predicate and possible upstream authentication event remain UNKNOWN. Current provider state is not established by these tests. Old windows remain expired and consumed. Implementer next reconciles fresh source-bound readiness before proposing the smallest necessary external qualification; owner and provider custodians retain separate external authority. No session is scheduled or launched by RV1. Same-job Sandbox payment, matching signed event, gate clearance, independent closeout and owner acceptance remain for 3A. Accepted milestones 1A/1B/2A/2B remain 4/8; 3A OPEN; R1 newly closed 0/27.

No scope deviation beyond the explicitly approved RV1 diagnostic change. No merge, push, deployment or production change.
