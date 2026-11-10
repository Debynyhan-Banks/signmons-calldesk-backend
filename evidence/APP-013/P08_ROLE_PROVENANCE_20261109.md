# APP-013 / 3A / P08 — approved role provenance extension

Owner approved governance proposal3df4f79 before implementation. Starting backendfe9581b/runtime50144cb. Exact five-task card: APP013_P08_ROLE_PROVENANCE_PROPOSAL_20261109.md. Demonstrated gap: DBR1 confirmed memberships and effective TEMP but retained no provenance; no need to repeat full qualification to obtain it. This work supports the existing same-job Sandbox payment prerequisite, not payment acceptance. Unrelated AGENTS.md preserved. No scope deviation beyond the explicitly approved query/administrative-metadata extension.

## Implementation and boundaries

Existing qualification_launch.py now supports --diagnose-role-provenance and --closeout-role-provenance using version2 of RoleDiagnosticCapability, separate APPROVE_EXACT_P08_DATABASE_ROLE_PROVENANCE committed authority/path, exact query/source/resource/runtime hashes, separate operation root and the existing three named SQL reservations. Version1 diagnostic and full qualification retain their original contracts. NativeIO permits the new query only for this capability. No new subsystem or dependency. Locked access_check.py unchanged.

One READ ONLY REPEATABLE READ catalog query returns target/admin/database identity, server version, target role count/superuser flag, database owner/default-ACL flag, relevant membership edges and database TEMP ACL entries. Membership query includes direct incoming edges and target's outgoing ancestor graph; each endpoint/grantor/admin/inherit/set option is explicit. Output labels INCOMING/OUTGOING/ANCESTOR. TEMP explanation distinguishes PUBLIC, DIRECT, INHERITED and SUPERUSER, with server pg_has_role USAGE and has_database_privilege cross-checks. Owner status alone does not imply TEMP. Names do not imply provider-managed status or safe revocation.

Strict byte JSON parsing and exact schemas/types/names reject missing/null/extra/duplicate fields, wrong identity, cycles, unrelated edges, unexplained effective permission and unsupported versions. PostgreSQL16–18 catalog contracts accepted; actual local SQL tested on installed16, parser fixtures cover17/18. Other versions return UNKNOWN. Up to64 edges and64 TEMP entries accepted; SQL selects at most65 of each so overflow is detected, not silently truncated or refetched. Existing transport/time caps preserved. Only fully validated bounded administrative metadata retained; malformed/incomplete output retains no provenance. Password/raw SQL output remain transient; no customer rows, project identifiers or token/cache/SDK/HTTPS access. Receipt always candidate null/executionReady false and impact DB_OWNER_REVIEW_REQUIRED.

Membership semantics verified against official catalogs for [PostgreSQL16](https://www.postgresql.org/docs/16/catalog-pg-auth-members.html), [17](https://www.postgresql.org/docs/17/catalog-pg-auth-members.html), and [18](https://www.postgresql.org/docs/18/catalog-pg-auth-members.html), and [privilege inquiry functions](https://www.postgresql.org/docs/16/functions-info.html). Actual provider version and metadata remain UNKNOWN until separately authorized observation; documentation compatibility is not a live test.

Reuse exclusive root/lock, source/runtime/environment checks, hidden input, cutoff and read/closeout deadlines, normal cleanup plus new independent SQL client. No retries/slot replay. Public closeout uses verified prior receipts without SQL or password; interrupted/hard-crashed histories remain UNKNOWN even with fresh session absence. No database modification, permission correction, migration, customer action, payment, deployment or new external packet/window.

## Validation and readiness

Local source timestamp: November9,2026 (UTC November10). Source/query/manifest fingerprints are mechanically recorded in the adjacent readiness JSON. Tests use committed synthetic authority in a temporary repository, mocked native-byte boundaries, owned child processes and an owned disposable PostgreSQL TLS cluster. Only exact host/port/CA is redirected for SQL tests; production serializers/queries/process lifecycle execute. No real provider calls.

Focused first run:27/28 tests passed; one test mutated its own saved envelope and was corrected. Corrected authority test passed. Initial sandbox initdb failure occurred before cluster startup; authorized local unsandboxed test used afterward. Actual TLS sources test passed; its direct disposable catalog null-ACL setup initially left stale test dependencies, corrected by restoring saved ACL in finally. Three actual SQL/TLS/crash tests then PASS4.066s; cluster reaped/scratch absent/providerCalls0. Additional TEMP-grant overflow case included in final full suite. These were test fixture corrections, not production role changes.

Readiness/checklist:
1. Separate capability/query/command/authority and original-mode refusal: implemented; tested.
2. Strict bounded provenance, type/version/identity/graph/permission consistency and safe UNKNOWN receipts: implemented; tested.
3. Three-slot lifecycle, deadlines, concurrency, interruption, hard crash, independent cleanup and no replay: reused and tested in new mode.
4. Actual PostgreSQL/TLS incoming/outgoing/chained inheritance, inherit false, PUBLIC/direct/default/absent grants and both overflow limits: tested. Null-ACL catalog mutation exists only in disposable fixture with finally restoration.
5. Existing diagnostic/full-module regression and repository gates: final result recorded below. Browser not applicable; no UI changes.

Responsible owners: implementer owns local validation/source readiness; DB owner owns provider-specific membership/provenance interpretation and shared-grant impact; credential custodian owns live hidden entry; owner approves any exact external operation/correction. Remaining UNKNOWNs: current server version, live role/membership/grant metadata, usable credentials/access, provider-managed membership meaning and affected application impact. Local tests do not resolve these.

No live qualification candidate, role correction or3A acceptance. Full qualification remains held. Accepted1A/1B/2A/2B4/8;3A OPEN;R1newlyclosed0/27. Next observable result after separately prepared/approved read-only packet is exact membership/grant provenance or explicit UNKNOWN with verified cleanup. No attendance needed for local completion.

Verification commands (run from source directory unless specified):
- `/opt/homebrew/bin/python3.14 -B -m unittest test_composed_qualification test_qualification_launch test_qualification_launch_postgres`
- Backend: `SIGNMONS_GOVERNANCE_REPO=<resolved governance> node scripts/check-governance-baseline.mjs`; `npm run arch:check`; `git diff --check`.
- Governance: `node scripts/frozen-baseline-check.mjs`; `SIGNMONS_BACKEND_REPO=<resolved backend> node scripts/docs-consistency-check.mjs`; `node --test scripts/frozen-baseline-check.test.mjs scripts/execution-placement.test.mjs scripts/intelligence-alignment-check.test.mjs`; `git diff --check`.

Final full regression:214tests PASS107.879s. Owned TLS server reaped,scratch absent,providerCalls0.25governance tests PASS;239distinct runtime/governance tests total. Architecture,baseline,consistency,source manifest and whitespace checks PASS. All five approved local checklist items complete. No fresh live observation or attendance request.
