# APP-013 / 3A / P08 — owner/project-only diagnostic local completion

Owner approved governance6496882 proposal before implementation. Exact requirement/source/acceptance, finite checklist, privacy/state/identity boundaries, exclusions, rollback and test commands are recorded in governance APP013_P08_OWNER_PROJECT_DIAGNOSTIC_PROPOSAL_20261109.md and its pre-code owner-decision section. Baseline implementation710e774; prior diagnostic evidence d5adc31. No live diagnostic approved, scheduled or run.

## Implementation

Only existing qualification_launch.py, test_qualification_launch.py and source-manifest.json changed. ProjectDiagnosticCapability validates exact schema, committed owner decision and scope hash, source/dependency/35SDK inventory, fixed owner/project/fingerprint, integer2CLI/0SQL/0HTTPS/0cache limits and bounded start/cutoff/read/closeout window. Actual kickoff rechecks cutoff; per-command gates check monotonic wall progression, original readEnd, dynamic environment/configuration and executable hashes. Existing NativeIO retains30second command cap,2second cleanup reserve,64KiB output limit, suppressed stderr and source-pinned SDK environment. Only owner then project may dispatch; project is never dispatched after failed owner validation.

--diagnose-owner-project reads a nonsecret0600 envelope without deleting the caller's file. Exclusive0700 operation root, entry lock and durable authority/attempt precede work; two immutable reservation/result pairs contain fixed descriptor, scope/operation IDs, elapsed milliseconds, match flag and safe error code only. Responses are parsed in memory and never persisted. Root inventory is fixed. No raw project number, account listing, token/password, stderr or arbitrary error reaches receipts. No database/target binding, recovery guard, private retained envelope or credential prompt is required. SDK-managed refresh/cache/internal retries remain a separately approved live exception, not a claim of zero credential access.

ProjectDiagnosticIO refuses SQL/direct HTTPS/token/other CLI commands. The production entry constructs this transport only after exact authority. Synthetic tests may inject explicitly proof-labelled IO; public CLI cannot. No full qualification/native/payment candidate is produced, including on success. Success means only exact owner/project matched within current bounds, with verified owned-process cleanup.

--closeout-owner-project validates the retained source-bound authority and root, takes the operation lock and permits one local reconciliation only. It performs no SDK/provider reads, does not kill caller-supplied/reused PIDs and never restarts work. Existing normal result with verified process cleanup can be reconciled; missing hard-crash history reports PROCESS_HISTORY_UNKNOWN. This is intentionally not a promise to reap unknown orphans after SIGKILL. No live readiness claim can erase this limitation.

## Tests and evidence

14 focused tests passed in9.688s: exact positive two-command flow and independent closeout; owner/project malformed/null/foreign/secret canaries; scope/authority/source/SDK/window mutations; configuration change and clock rollback; SQL/HTTPS/token refusal; diagnostic write failure; actual subprocess bytes with real NativeIO/environment/deadline; timeout/oversize cleanup; concurrent duplicate start and closeout; unknown hard-crash history; actual public SIGKILL plus fresh public closeout; actual SIGTERM reaping of owned child; stale capability/read deadline/expired local closeout; environment override and false approval.

Full producer/recovery/model/owned PostgreSQL-TLS regression result is recorded in P08_OWNER_PROJECT_DIAGNOSTIC_RESULT_20261109.json. Earlier full-suite results remain historical. Governance frozen baseline, complete cross-repository consistency,25 governance tests, architecture and whitespace checks apply. No browser/application/UI change; same-job Sandbox acceptance remains downstream.

## Finish and remaining limits

Completed local capability/entry/transport/receipt/cleanup and focused tests. Full validation result must be saved before declaring completion. Rollback only these source/test/manifest changes; retain immutable prior operation receipts and unrelated user AGENTS.md. No dependency/permission/request/timeout expansion. No new acceptance section or provider authority.

Next, only after local verification, a separately requested concrete exact external packet may be prepared and approved. The current root cause of Q5's SDK stall and Q4's permission failure remains UNKNOWN. This mode cannot explain SDK internals and cannot qualify3A. Prior Q5/R13 cleanup remains verified. Accepted1A/1B/2A/2B4/8;R1newlyclosed0/27;3A OPEN. No scope deviation beyond the approved diagnostic addition.

Final validation complete:158runtime/local PASS in77.270s plus25governance PASS,total183. OwnedTLS server reaped/scratch absent,providerCalls0. All approved local checklist items complete. No actual external operation packet or live authority created.
