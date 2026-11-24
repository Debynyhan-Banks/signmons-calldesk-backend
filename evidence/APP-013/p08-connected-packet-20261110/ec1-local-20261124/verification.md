# EC1 local implementation and verification — November 24, 2026

APP-013 / 3A / P08. The owner approved “EC1 local correction and tests” against governance proposal c91285a. Decision, complete card and 18-file pre-edit inventory were committed at governance 807cf80 before coding. Backend base f675067 contains the unchanged prior runtime 9f5f5bf plus read-only reproduction evidence. This report concerns local implementation only.

## Result

The current custom-token exchange accepts the documented response without localId. A supplied conflicting, null or nonstring localId still refuses; idToken must be a nonempty string. The exact source extraction guard includes only this approved semantic transformation. Current successful exchange fixtures now omit localId and use the documented field shape; lookup/update response contracts retain localId.

The existing authenticate() source is byte-for-byte unchanged: exact in-memory token, current Firebase identity/claims, token identity/issuer/audience/time rejection and the protected exact-job read remain mandatory. Decoding is rejection-only. The native child awaits this authentication before payment. No new verifier, provider operation, endpoint, credential handling, schema or UI is introduced. RV1 safe reason codes, no retry, deadline, cleanup, private purge and success-only digest behavior remain intact.

## Verification

| Existing suite | Passed |
| --- | ---: |
| Coordinator client: node --test test_client.mjs | 64 |
| Real-client binding: node --test test_bound.mjs | 10 |
| Real-client binding: python3 -B -m unittest test_bound | 19 |
| Native Node: node --test test_connected_payment.mjs test_transports.mjs | 57 |
| Native Python: python3 -B -m unittest test_entry test_child_cleanup test_key_lifecycle test_private_inventory_cc1 | 151 |
| Applicable connected-packet discovery | 419 |

Total: 720 applicable local tests passed. The 21 new direct-client tests and the 21 native scenarios within three new test methods are included, not counted twice. Native positives exercise actual client -> authenticated job read -> synthetic payment -> child journal -> Python parent -> main and independent closure. Negatives cover foreign/null/nonstring localId, missing/null/nonstring/empty token, foreign sub/tenant/role/testOnly/issuer/audience, expired/future claims, matching optional localId with wrong token identity, runtime 401/403 and wrong job. They assert no payment writes or presenter call, no accepted auth proof/digest, preserved AUTH_OUTCOME_UNKNOWN, safe private-data exclusion, one issuance, refused second child dispatch and cleanup.

One initial new-test assertion expected --closeout on successful authentication. Source inspection and an existing lifecycle test showed the successful parent path correctly uses preflight, run and three readbacks, including main and independent closeout receipts. The new assertion now checks that exact sequence and successful results; the failure-path --closeout assertion remains. Production lifecycle code was not changed. The initial failed log is retained as native-python-initial.log. A subsequent full run exposed a shared fixture clock race: the parent captured a second boundary before the payment fixture read the clock again, so a 60-second reserve became 59 seconds and authority correctly rejected PAYMENT_TIMING before child execution. The payment fixture now derives its unchanged offsets from the parent's captured clock. The failing log is retained as native-python-clock-race.log, the affected focused test passes, and the final full suite passes in native-python-tests.log. Production timing predicates are unchanged. No existing assertion was relaxed to permit missing cleanup.

Connected discovery excludes exactly the same seven explicitly inapplicable tests reviewed in the approved card: five CT3DisposableTLS methods and two actual browser-launch methods. Their IDs are printed in connected-tests.log. Native test_native_postgres.py is also inapplicable. All tests use injected provider transports; process/loopback suites ran with host permissions. No real database, browser, cloud account, credential/cache or payment action occurred. App build/lint/database/browser gates are inapplicable to this standalone internal change, and no historical results are presented as newly run.

## Source integrity and scope

Exactly 18 current source/test/reference files changed: two runtime/guard files, two synthetic response producers, two direct test files, two hash-only handoff files and ten current JSON manifests. source-audit.json verifies 417 file references, 39 JSON digest-only replacements and all 10 unchanged tracked R56 evidence files; no stale current digest remains. Five embedded source-lock replacements are covered by the existing serialized/bound/native guards. Manifest keys/status/purpose/baseline/SDK pins are unchanged. The user's AGENTS.md change and pre-existing untracked renewal files were preserved.

Actual coordinator, serialized, bound and native source guards passed, as did backend governance, architecture, frozen baseline, complete consistency and whitespace checks. Independent final code review found no remaining defect or out-of-scope behavior. Final governance test/check results are recorded in the governance EC1 completion and final-gates records after canonical status updates.

## Boundaries and next observable result

The six approved local checklist items are complete. This corrects the reproduced compatibility bug; it does not establish which response R56 actually received or resolve that historical authentication outcome. R56 AUTH_OUTCOME_UNKNOWN, null success-only proof digest and all immutable receipts remain unchanged. Local synthetic payment is not current live evidence or owner acceptance.

Implementer next reconciles the corrected source with fresh readiness and the smallest necessary external qualification; the owner and cloud/database/Stripe custodians retain separate live decisions. No new session, credential operation, deployment, live payment or retry is authorized by EC1. Remaining 3A acceptance is same-job Sandbox payment, authentic matching event, gate clearance, independent closeout and owner acceptance. Accepted 1A/1B/2A/2B remain 4/8; 3A OPEN; R1 newly closed 0/27.

No scope deviation beyond approved EC1. No push, merge, deployment or external action.
