# APP-013 / 3A / P08 — native entry local result

Owner approved the finite local implementation in `APP013_P08_NATIVE_ENTRY_QUALIFICATION_PROPOSAL_20261101.md` with “i approve” on November 1. Implemented and locally tested; no external operation or customer acceptance. Source entry backend `d5f1f876e8f17f8236d2262d1856a6fa323a86a4`, governance `996cc7fb5be906ddf64d1d337c7fa6dc24a3a001`; changes remain uncommitted. Verification completed November 1, 2026, by 13:34 UTC. Historical source/manifests and the preexisting `AGENTS.md` change were preserved.

## Delivered against the approved card

1. Eight new runtime files assemble the existing coordinator, native primitives and serialized authentication sequence. An outer envelope binds operation, source, resources, target, qualification, deadlines and finite call budgets. Native resolution requires the exact committed external owner decision and committed source; local proof capability cannot dispatch native defaults. No such external decision was created.
2. One coordinator journal owns lifecycle and cleanup. Child calls revalidate the same envelope and reserve an exclusive numbered call before using ports. Historical local capability projection occurs only inside this independently validated boundary. The existing coordinator, client, recovery and source validators remain unchanged.
3. Native primitives use explicit owner/override checks, hidden in-memory credentials, pinned PostgreSQL executable/database, verified TLS, explicit SQL allowlist, bounded command/request results, exact Google hosts and an independent session probe. Readbacks derive account/Firebase/session/runtime facts from actual interfaces; fixture flags do not supply final private absence.
4. Exact operation-private inventory rejects foreign files, symlinks, wrong modes and unfinished atomic intents. Credentials travel in process memory/pipe. Envelope and owned receipt are purged after completed closeout; sanitized reservations/journal/result remain to prevent replay. An interrupted parent that has not reached final purge can be closed by a fresh coordinator after the start cutoff, once, without authentication replay. Completed unconfirmed outcomes remain residuals; no automatic retry or claim of successful recovery follows.
5. Source and test provenance are separate. Actual assembled `verify_sources()` and inherited validators passed after the final runtime edit; test hashes were verified after the final test edit.

Runtime manifest SHA256: `8b3ba5afcba4c80a73df8e8e4d0a61e5edc93025efda4775aef02e5711206201`.
Test manifest SHA256: `7f82b67573f7a8eb539e82591b23d0e703e1b1d5c033fb4f17c970f876548e1e`.

## Fresh verification

All paths below are relative to backend `evidence/APP-013/`. Every listed runtime suite was run in this turn, with fake providers; PostgreSQL was an owned disposable loopback TLS fixture.

| Command | Result |
| --- | --- |
| `python3 -B p08-native-entry-local-20261101/source/test_entry.py -v` | 18 PASS: assembled success, authority/source/identity/config refusals, actual native owner/SQL serialization with mocked subprocesses, duplicate/concurrent start, lost output, timeout, session disagreement, private inventory, independent post-cutoff cleanup and late/rollback refusal |
| `node --test p08-native-entry-local-20261101/source/test_transports.mjs` | 6 PASS: actual child, replay refusal, native/proof separation, forged capability, output size/host/budget/cleanup constraints |
| `python3 -B p08-native-entry-local-20261101/source/test_native_postgres.py -v` | 5 PASS: trusted TLS/actual SQL/child sequence, cleartext refusal, untrusted certificate refusal, suspended tenant refusal, actual leftover session refusal; zero external provider calls |
| `python3 -B p08-real-client-binding-local-20261031/source/test_bound.py` | 11 PASS |
| `python3 -B p08-serialized-handoff-local-20261031/source/test_handoff.py` | 11 PASS |
| `python3 -B p08-native-closeout-local-20261031/source/test_adapter.py` | 8 PASS |
| `python3 -B p08-live-binder-local-20261029/source/test_coordinator.py` | 12 PASS |
| `python3 -B p08-native-bridge-local-20261029/source/test_bridge.py` | 13 PASS |
| `python3 -B p08-restoration-local-20261028/source/test_restore.py` | 31 PASS |
| `node --test p08-real-client-binding-local-20261031/source/test_bound.mjs p08-coordinator-auth-local-20261031/source/test_client.mjs p08-live-binder-local-20261029/source/auth/auth-handoff.test.mjs` | 23 PASS |

Totals: 29 new cases; 109 unchanged focused regressions. Governance safeguard tests: 25 PASS. Backend `npm run lint`, `npm run build`, `npm run arch:check`, required cross-repository baseline check, governance frozen-baseline/docs-consistency checks and whitespace checks PASS. No browser gate applies because no UI changed. These results do not claim all application tests or current live compatibility.

Initial development failures were resolved before finalization: the fake job response used `id` instead of the actual `jobId` contract; the parent readback parser rejected the child's fractional ISO timestamp; the cleartext test also broke its cleanup probe's TLS configuration; and a late-cleanup test expected a different error label from the reused validator's mode-specific `START_CUTOFF`. The fixture now faults only the primary connection while independently verifying cleanup over trusted TLS; certificate refusal assertions were tightened. Native executable review found `/opt/homebrew/bin/psql` absent and reused the historical pinned `legacy.PSQL` instead. No historical validator, acceptance criterion or frozen anchor was relaxed.

## Readiness record and remaining facts

Evidence timestamp for this table: November 1, 2026, 13:34 UTC. Exact file hashes are in the runtime/test manifests above; base source commits are recorded at the top. Implementer owns local verification. This record is qualification-only planning, not execution readiness.

| Prerequisite / inspected interface | Current result | Owner / next evidence |
| --- | --- | --- |
| External envelope, source and decision: `authority.Capability`, `authority_bridge.authorizeChild` | Local positive/refusal tests PASS. Exact external decision and committed new source ABSENT. Fake committed readbacks test the parser only. | Owner approves a future exact operation; implementer pins committed reviewed source before launch. |
| CLI/HTTPS/SQL parsing and credentials: `NativeIO`, existing `Ports`/`NativeAdapter`, `createPorts`, `boundClients` | Local serialized/provider-error/SQL/TLS tests PASS. Real owner credentials, CLI output, effective permissions, API/key compatibility UNKNOWN. | Owner/provider administrator; current bounded qualification through actual interfaces. |
| Dynamic runtime and role configuration: qualification hashes plus existing runtime/ACL validators | Exact configuration hashes required; local mismatch refusal PASS. Current candidate environment, role ACL, traffic, identity and secrets UNKNOWN. | Implementer under separate approval; derive hashes from current authoritative outputs. |
| Account/Firebase/job/session: existing conditional SQL and identity validators, independent raw readback and session probe | Local and disposable SQL results PASS. Current CHILD/Firebase/operator/job state UNKNOWN. | Owner and implementer under separate read approval; no activation/token issuance during qualification. |
| Deadlines, one attempt, concurrency, interruption | Local entry/child/refusal/recovery tests PASS. Internal authentication start still uses the original start cutoff; later work deadline does not extend it. | Implementer compares actual future command and window with these validators. |
| Private inventory and closeout | Local inventory, purge and fresh-coordinator post-cutoff recovery PASS. Actual live private state and provider cleanup UNKNOWN. | Implementer during separately authorized operation. Unconfirmed closeout is a residual, not success. |
| Billing and access | No current reads. R10's historical Cloud pass does not refresh billing. Historical API Keys service disabled/key absence denied; role normalization correction is local only. | Owner/provider administrator resolves or explicitly qualifies the narrow access question; no broad R10 replay. |

The new CLI has `--run` and `--closeout`; it is not a read-only qualification launcher. Do not invoke `--run` to obtain missing qualification. The existing qualification launcher and `Ports.key_service_get` remain source references for a separately scoped read. No fresh operation UUID, window, real envelope, credential or external command was prepared. The exact native entry refuses until source, owner approval and qualification bindings exist.

Remaining finite customer path: current targeted access/current-state qualification and any separately approved remediation; exact approved authentication/restoration operation; same-admitted-job Sandbox Checkout, authentic matching settlement/failure/replay evidence; owner acceptance. The next observable result is a source-bound narrow access decision/qualification receipt, not another local demo or a replay of R10. No further prerequisite implementation is authorized by this result.

3A remains open; accepted 1A/1B/2A/2B **4/8**, newly closed R1 **0/27**. No real credentials, provider calls, billing/payment actions, customer data changes, merge, push or deployment occurred. Rollback removes the fresh directory and its current handoff references, preserving historical proof. **No scope deviation beyond the approved local native-entry integration.**
