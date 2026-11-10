# APP-013 / 3A / P08 — approved administrative membership correction

Owner approved governancef0ae9aa before coding. Complete pre-code card APP013_P08_ADMIN_MEMBERSHIP_IMPLEMENTATION_CARD_20261110.md records source/dependencies/behavior/checklist/tests/owners/retention/rollback. Base backend7f57a41,prior runtime4012c92. No scope deviation beyond the exact owner-approved membership prerequisite amendment;no TEMP waiver or live mutation. Existing same-job Sandbox payment acceptance remains unchanged.

## Final behavior and source boundaries

access_check.py now has one shared strict classify_memberships policy. It accepts zero edges or exactly member neondb_owner,role p07_payment_runtime,grantor cloud_admin,ADMIN true,INHERIT false,SET false,with fixed neondb/admin identity for the exception. Detailed fields and count must agree. PostgreSQL16–18 numeric version and exact typed fields required. Any additional/outgoing/foreign/duplicate/malformed/unsupported/incomplete observation fails. Query retains full actual count and at most2 edge rows;more than1 fails,not silently truncated into success. No raw count is subtracted or normalized.

Current full qualification uses the shared classifier through its existing adapter. Native RuntimeAdapter.role validates the same policy before phase/ACL evidence;its role readback overrides the inherited blanket-zero-membership check while preserving active expiry/login/limit and retired session/expiry conditions. Other resource readbacks still delegate unchanged. Raw membership count and rows remain truthful in memory. Immutable historical restore.py,role provisioner,original source copies and result/operation receipts remain untouched. Current three runtime manifests and two test manifests explicitly repin only changed owned files and the active access_check dependency. Old/new byte hashes recorded in adjacent readiness JSON;no governance baseline anchor change.

All other role attributes,ownership,session checks,schema CREATE,database TEMP and complete ACL expectations remain enforced. A matching admin edge plus PUBLIC TEMP still produces ROLE_NOT_READY. SQL-only fixed diagnostic noMemberships continues to describe the literal zero-membership fact;it is not a substitute for the authoritative membership policy. No extra role privileges granted or read permissions widened. No credential/private target/token/customer data retained;no new arbitrary logs,operation window or provider call.

## Local evidence

Focused shared membership/retired unit tests13PASS;native phase tests2PASS. Two combined current-qualifier/actual PostgreSQL tests PASS2.010s. Actual owned cluster reproduces non-superuser CREATE ROLE automatic membership by temporarily naming its bootstrap role cloud_admin and creating neondb_owner with CREATEROLE. This genuinely produces the exact administrative tuple. Fixture finally restores original owner names/grants and removes temporary roles;server and scratch cleanup independently verified.

The real serialized query passes current full qualification and native active,retired and fresh-independent role readbacks. Changed inheritance option,additional membership and PUBLIC TEMP fail. Unit matrix covers all tuple fields,missing/null/type/version/identity/count/extra/outgoing drift and preserved nonmembership predicates. Native/current regression reuses source guards,exclusive windows/reservations,concurrency,interruption,crash and independent cleanup tests.

Initial access suite found stale test-manifest runtime hash after expected source changes;test manifest refreshed explicitly. Initial new current-proof case used fixture_child identity with a policy requiring neondb;corrected the synthetic case identity/scope before testing. Neither failure changed policy or relaxed tests. No actual provider attempts.

Commands run with /opt/homebrew/bin/python3.14 -B from each source directory:
- Access: `-m unittest test_access_check test_retired_role_postgres`.
- Native: `-m unittest test_entry test_native_postgres`; `node --test test_transports.mjs`.
- Current: `-m unittest test_composed_qualification test_qualification_launch test_qualification_launch_postgres`.
- Backend architecture,cross-repository baseline and whitespace;governance frozen baseline,complete consistency and25governance tests. Browser N/A;no browser/UI changes.

## Readiness and remaining boundary

Local readiness covers actual query/output serialization,strict policy/version/identity,manifest dependency pins and old-envelope drift refusal,active/retired phases and cleanup. Same current role query's descriptor hash changes;future exact packets must bind the new source/manifest/query. Existing consumed RP3 cannot be replayed. Local fixture evidence does not renew live authority or prove current role readiness.

DBR1/RP3 previously established PUBLIC TEMP as the sole effective target TEMP source;that requirement remains unsatisfied until a separately reviewed DB-owner correction. Shared consumer impact and required preserved grants remain UNKNOWN. The admin/provider trust decision is the owner's exact approved tuple,not a claim that historical creation/bootstrap identity was independently proven. No outgoing inheritance or broad incoming-membership exception.

Implementer owns local implementation evidence;DB owner owns shared TEMP impact/correction;owner/credential custodian must separately authorize any live operation. Next observable result is a bounded TEMP impact/correction proposal based on existing records first;no full qualification retry or password request now.3A OPEN;accepted1A/1B/2A/2B4/8;R1newlyclosed0/27.

Final validation:122access tests PASS9.623s;30native tests PASS10.377s;6transport tests PASS926.108ms;216current qualification/diagnostic tests PASS110.498s;25governance tests PASS. Total399PASS. All owned database servers reaped,scratch absent,providerCalls0. Source/test manifests,architecture,frozen baseline,complete consistency and whitespace PASS. All five approved checklist items complete.
