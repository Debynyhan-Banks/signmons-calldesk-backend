# APP-013 / 3A / P08 — service-only amendment local result

**Implemented and locally tested. No live API enablement, credential read, provider request or external operation authorized.** Owner replied “i approve” to the explicit local implementation/testing decision for APP013_P08_SERVICE_ONLY_ENABLEMENT_CHANGE_REQUEST_20261103.md (governance da40c11). Backend entry a0d352b736e78c29925649073f024d7256668ba7. Pre-code section card records exact interfaces, parser choices, scope, acceptance trace, tests and exclusions.

## Behavior and boundaries

The existing access_check.py now retains version-2 --read/--closeout and adds distinct version-3 ServiceCapability/ServiceNativeIO/ServiceReader with --enable/--closeout-enable. One shared bounded serializer, cached-token guard, source/committed-decision binding, exact inventory/lock and closeout are reused. Only this module, its tests and two manifests changed; no broader coordinator/native-entry/historical module or production code changed.

Version 3 binds exact owner/project/fingerprint, serviceRetention=RETAIN_ENABLED, distinct decision path/string, source/contract hashes, same fixed deadline offsets and one cache/ten HTTPS/one enable mutation/zero CLI/SQL/refresh/retry budget. V2 approval cannot authorize V3; local authority is rejected by native transport. An enable intent is journaled before dispatch. Requests check project, four exact owner permissions and current API state; already ENABLED skips mutation. Otherwise one empty-body enable POST, up to five two-second pending-operation observations, and mandatory final service GET. Only successful pending responses permit another observation; failed calls never retry. Fixed hosts/paths, no redirects/proxies, eight-second/65536-byte limits remain.

Operation parsing handles absent/null/default-false done without mistaking it for success. Explicit true requires exact completed service response; foreign operation/resource/type, malformed values, simultaneous error/response, provider errors or insufficient permissions stop. Operation names remain memory-only; a validated name hash is retained. Five pending observations, interrupted/failed enable, incomplete response or unverified final state produce SERVICE_ENABLE_OUTCOME_UNKNOWN. No automatic disable, cancellation or replay. Successful enabled state would be retained only under the future exact external approval. No claim that enabling resolves billing or runtime access.

Service statuses are SERVICE_PREEXISTING_ENABLED, SERVICE_ENABLEMENT_OBSERVED, SERVICE_ENABLEMENT_STOPPED or CONTAINMENT_UNCONFIRMED; every result retains executionReady=false. Journal records enableAttempted, operation hash/done, prior/final state and ordered calls. Independent closeout uses the same exact plan/attempt/journal binding, performs no credential/provider calls and preserves remote uncertainty. Memory references clear even if closeout raises. Local cleanup cannot guarantee remote completion or secure memory erasure.

## Verification

At 2026-11-03 13:30:47 UTC: **76 focused tests PASS** (49 prior cases retained, 27 new service cases); **25 governance safeguards PASS**; actual source validator, frozen/cross-repository baseline, docs consistency, architecture, both whitespace and prior immutable receipt hashes PASS. Source validator returns localTransportReady=true, ready=false / EXTERNAL_QUALIFICATION_NOT_AUTHORIZED. This is source/local evidence, not live readiness.

Command: `/opt/homebrew/Cellar/python@3.14/3.14.2/Frameworks/Python.framework/Versions/3.14/bin/python3.14 -B evidence/APP-013/p08-narrow-access-check-local-20261101/source/test_access_check.py -v`. Also actual pinned Python -I -B source --check-source; node scripts/architecture-check.mjs; backend check-governance-baseline with resolved governance; governance frozen-baseline/docs-consistency with resolved backend; node --test scripts/frozen-baseline-check.test.mjs scripts/execution-placement.test.mjs scripts/intelligence-alignment-check.test.mjs; git diff --check in both repositories.

New cases exercise actual V3 entry and native serialization with synthetic SQLite/cache and mocked HTTP; socket connections are forbidden. Disposable Git proves pending refusal, actual committed-reader authority and source-drift refusal without writing synthetic approval to real governance. Success, preexisting state, five-poll ceiling/exhaustion, missing/null/error output, source/retention/budget/mode gates, interruption at all eleven possible reservations, poll wait failure, concurrency/duplicate refusal, final-readback requirement, deadlines/clock rollback, private-data absence, independent recovery and persistent journal/purge failures are covered. Temporary fixture roots/repos/caches are removed. No live plan or window created. Browser/application build/database gates do not apply to this isolated Python change.

Initial results retained: first 49-case regression run exposed a pre-existing float-to-microsecond fixture rounding at the exact token-expiry boundary; changed only its synthetic deadline to an integral second, preserving strict expiry > purgeEnd. An initial journal-interruption case accidentally injected failure on every subsequent write while expecting one interruption; split it into a one-interruption recovery test and a persistent-failure refusal test. Final 76-case run passed; no production expiry/authority/no-retry rule weakened.

Persistent filesystem failure can prevent journal completion/private-plan purge: tests require refusal, closed transport and no success result. A live packet must include attended exact-owned-root manual cleanup/UNKNOWN reporting for this case, verify parent exit/exclusive lock and finish before purge deadline; no automatic purge timer is claimed. After an attempted enable, remote state may remain UNKNOWN even when local cleanup succeeds. This is an explicit retained uncertainty, not permission to retry.

## Source pins

- access_check.py: `c608a7ea3d9b8feee7af0131eaa37d7f92c7e2abb6739f513866d27d840e5616`.
- source-manifest.json: `816b1c774f46bb515b20ad9beeeaa3e4d30332884b4750faa8f6a66083974715`.
- test_access_check.py: `521ed9f2b8f1532a108d8f1c616d9d61305f374bd8137a023e3d163a05c009e2`.
- test-manifest.json: `65c929a6b410918a965ffaaffa6f5989eaba5adcacff854a6c218bcd4cf763ab`.

Historical source/manifest at 8e35617 and prior operation receipts remain unchanged in Git. The working source has new hashes; no historical packet is valid authority for it. SERVICE_ONLY_LOCAL_VERIFICATION_20261103.json records the local checks and byte hashes.

## Readiness and next observable result

| Prerequisite | Evidence/status | Responsible role |
| --- | --- | --- |
| Service-only entry/serialization/identity/authority/limits | Implemented; actual boundary tests PASS at hashes above | Implementer pins source in a fresh packet |
| Output defaults/null/error/resource contracts | Isolated native serialization/parser and disposable-Git cases PASS; actual future enable response UNKNOWN | Implementer/provider administrator; fail closed if shape differs |
| Concurrency/deadlines/recovery/private retention | Local tests PASS, including persistent-failure refusal and remote UNKNOWN | Executor remains responsible for attended closeout/verification |
| Last observed provider state/access | November 3 13:15 qualification: service DISABLED, roles exact, requested owner permissions present; immutable consumed evidence | Provider administrator; future action rechecks required access and service |
| Future cached credential/config usability | UNKNOWN. Prior validity-through-13:30 evidence is not a guarantee for any later window | Credential custodian; separately scoped preparation if necessary, no automatic renewal |
| Exact committed external decision, window and retained enabled state | ABSENT; no external operation created or scheduled | Owner decides a concrete packet after readiness comparison |
| Billing/runtime/Firebase/database/job/key/payment/full P08 | UNKNOWN/unresolved; excluded from this amendment | Existing responsible owners and later approved scopes |

Approved local checklist 1–5 implementation, isolated verification, source provenance and readiness reporting complete. Next observable result: a fresh source-pinned service-only operation proposal with exact authority/window/credential-validity and attended closeout duties, or a specific unresolved prerequisite. No live approval is requested from this local result and no credential renewal is implied. Rollback is restoration of only the four source/test/manifest files from a0d352b; historical provider evidence and unrelated AGENTS.md remain preserved.

APP-013/3A open; accepted 1A/1B/2A/2B **4/8**; R1 newly closed **0/27**. Prior qualification, renewal and R10 remain consumed. **No scope deviation beyond the owner-approved service-only amendment.**
