# P08 split diagnostic and key-lifecycle local result

R1-W01 / APP-013 / 3A / P08. Debynyhan Banks replied “i approve” to the exact request for bounded local correction and isolated tests against governance proposal commit `258273e`. This authorized disabled Stage A implementation and the Stage B refusal boundary only. No provider, API, key, IAM, account, database, authentication, runtime, Stripe, payment, spending, deployment, merge or push action was authorized or performed.

## Implemented locally

Fresh evidence-only Stage A source lives in `source/diagnostics_stage.py`; old access/restoration/authentication evidence remains unchanged. Its manifest pins both new files and the old access-model/test hashes. Native execution validates source locks, prints `P08_DIAGNOSTICS_STAGE_REFUSED_UNBOUND`, and exits before credentials or provider clients. No HTTP client, gcloud launcher, credential resolver, database client, signing or token exchange exists in the new source.

The controller models exactly one service, `policytroubleshooter.googleapis.com`, with GET, conditional enable, bounded LRO polling and exact enabled readback. It models exactly four existing-resource diagnostics. It refuses all API Keys hosts and all Stage B calls. A complete four-`CAN_ACCESS` result is only a Stage B candidate; `stageBActionAuthorized` remains false. Unknown, denied, unsupported, malformed and incomplete outputs never qualify Stage B.

Retention remains a modeled `RETAIN_IF_ENABLED` future decision. There is no disable request, force/bypass path or claim that provider side effects are known. Process closeout and service retention remain separate. Independent closeout is read-only and uses the exact journal/plan binding; it cannot enable a service or enter Stage B.

## Verification

Final pass: 24 new diagnostics-stage tests, 40 unchanged old access-model tests, 31 unchanged restoration tests and 60 unchanged authentication tests, 155 total. New coverage includes exact serialized requests, disabled/preexisting service branches, enable LRO/readback, four typed diagnostics, unknown/denied/invalid results, strict hosts/output/operation names, no automatic disable, Stage B refusal, provider denial/lost responses, bounded polling/no mutation retry, real SIGINT/SIGTERM across modeled transitions, request timeout, deadlines/clock rollback, exact closeout, foreign journal, real two-process reservation race, one-use attempt, source drift, privacy and native refusal.

The first new test run had 13 fixture errors because LRO polling advanced a shared synthetic clock across subcases. The fixture now resets the clock per subcase; controller logic and failure assertions were not weakened. The first unchanged authentication run stopped before tests because the suite uses an undecoded `import.meta.url` pathname and the checkout contains `Web Projects`. The unchanged source then passed 60/60 from a private no-space copy, matching its established workflow. That scratch copy contained no private data and its absence was verified afterward. Exact commands, outcomes and corrections are in `verification.json`.

No PostgreSQL or browser test was added: this evidence-only change has no SQL, schema, application route or UI behavior. No historical runtime result is presented as new. Required governance, architecture and whitespace results are recorded after the final source and documentation checks.

## Remaining and next observable result

This is implemented and locally tested only. It is not live-demonstrated, externally qualified or owner-accepted as 3A. Policy Troubleshooter remains last observed disabled. No permission diagnostic has run through this new Stage A model. API Keys remains last observed disabled; no compatible key exists from this work.

The next reviewable item is a fresh exact Stage A external operation proposal: current owner/project/service binding, conditional Policy Troubleshooter enable and retained state, four diagnostics, bounded requests, truthful unknowns and process closeout. That future operation needs separate owner approval. Stage B API Keys readiness/key lifecycle remains blocked until Stage A actual facts support it and a separate card/approval is complete.

Accepted 1A/1B/2A/2B, 4/8 walkthrough; 0/27 newly closed R1, 6/60 legacy, 0/13 intelligence unchanged. **No scope deviation within the approved local correction.**
