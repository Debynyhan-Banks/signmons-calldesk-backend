# APP-013 / 3A / P08 — PostgreSQL recheck after host restart

**Current November 1 status — approved repair verified:** runtime manifest restored byte-for-byte to its original six-file contract; separate `source/postgres-test-manifest.json` records the two unchanged database tests. Actual `bound_handoff.verify_sources()`, all eight file hashes and 11 handoff tests pass after finalization. See `MANIFEST_REPAIR_RESULT_20261101.md`. Historical failure/results below are preserved. Qualification planning is complete in governance `APP013_P08_NATIVE_ENTRY_QUALIFICATION_PROPOSAL_20261101.md`; material native-entry implementation remains proposed, not approved or implemented. **Previously disclosed manifest drift repaired under explicit owner approval; no further implemented deviation.**

**Subsequent readiness correction:** direct use of the actual source validator found `MANIFEST_SHAPE` because the preceding turn added two test entries after the handoff suite ran. The ten database passes reported here remain valid for the tested files, but the final assembled bundle is not qualified. Governance `APP013_P08_QUALIFICATION_READINESS_STOP_20261101.md` records the failed gate, exact repair proposal and stop pending owner direction. **Unintended manifest drift disclosed.**

Initial recheck verified November 1, 2026, by 12:35 UTC (7:35 a.m. Eastern); integrated proof and final gates completed 2026-11-01T12:40:00+00:00. Owner directed proceeding with the saved local PostgreSQL recheck and readiness reassessment. Backend source `d5f1f876e8f17f8236d2262d1856a6fa323a86a4`; governance entry `996cc7fb5be906ddf64d1d337c7fa6dc24a3a001`. No implementation change.

## Actual local execution

The first sandboxed invocation used the unchanged restoration copy at `evidence/APP-013/p08-restoration-local-20261028/source/auth/test_auth_postgres.py -v`. It stopped in `initdb` with the fixture's generic `LOCAL_POSTGRES_COMMAND_FAILED`; zero cases ran. The fixture suppresses subprocess stderr, so this result does not establish a repeat of October 31's shared-memory exhaustion.

The source-pinned authentication suite then ran with approved host execution:

```sh
python3 -B evidence/APP-013/p08-authentication-local-20261026/source/test_auth_postgres.py -v
```

Exit 0; **five cases passed in 3.090 seconds**:

- Actual conditional activation/disable roundtrip preserves the row and audit; fixture session count returns to zero.
- Concurrent conditional activation permits one winner.
- Foreign/missing identity, wrong role and stale version refuse.
- Already-active or changed-version rows prevent cleanup takeover.
- TCP targets refuse before connection.

The fixture creates a unique `/private/tmp/p08-pg-*` database and private Unix socket, disables TCP listening, removes inherited `PG*`/`DATABASE_URL`, stops its server and asserts scratch-directory removal in teardown. The suite completed teardown without error. No shared-memory setting, unrelated process or persistent database was changed. No real credential, provider request, runtime, payment or customer action occurred.

## Source and evidence limits

SHA256 of the executed suite: `cadc849b7395dd7574e24d2e73b6d531db5430a564b382423e0b129a018eadcf`.

SHA256 of its historical adapter: `ee4906f969ae40e40b4c4a066829afc63257c62a8e9e60fcdbc1ea376b91855a`.

SHA256 of its disposable PostgreSQL fixture: `f4a7ded4cecb41ba4b0fa9fe746f403d0d10635e48937bd5459b6e217f2a3f33`.

A current Node assertion confirmed the extracted coordinator client's exported SQL equals the tested historical adapter's SQL. All six files in the binding source manifest match their recorded hashes. This supports reuse of the tested predicates; it is not an integrated real-database test of `boundClients`. The socket suite does not exercise TLS, the new `PREFLIGHT_SQL`, or the new factory/session-probe integration. Those new boundaries still have only October 31 injected coverage. No TLS/live-authentication pass is claimed.

## Integrated SQL/TLS/session completion

The readiness review found that the historical socket suite alone did not fulfill the approved card's integrated SQL/TLS/session requirement. The exact additional test matrix was entered in the existing card before implementation. Two test-only files now reuse the unchanged historical migration/fixture lifecycle and actual `boundClients` interface. The server listens only on 127.0.0.1 and its owned private socket, with a generated one-day certificate and key under the owned temporary root. No production or disabled implementation source was changed.

```sh
python3 -B evidence/APP-013/p08-real-client-binding-local-20261031/source/test_bound_postgres.py -v
```

Approved host execution exited 0: **five cases passed in 2.330 seconds**. They exercise the actual `pg` client and `boundClients` factory:

- A verified TLS connection executes the actual tenant/database/user preflight, activates and disables the synthetic operator with the actual conditional SQL, rejects a stale disable and closes with zero sessions.
- A real cleartext connection is refused and closed.
- A real connection with an untrusted certificate is refused and closed.
- A suspended tenant fails the actual preflight and closes.
- An additional real session with the operation's application name prevents successful closeout; the test then closes its extra session and verifies zero remain.

The test's independent session probe uses a separate verified TLS connection. Every case asserts zero operation sessions at completion. Fixture teardown stopped the owned server and asserted removal of its temporary root, including certificate/key; synthetic coordinator journals were removed. Test hashes are recorded in `source/source-manifest.json`. The earlier five socket cases remain unchanged.

The host startup blocker and the local integrated SQL/TLS/session coverage gap are now resolved. This is local fixture proof: production CHILD TLS/identity, real credentials, provider permissions/state, actual runtime/account/Firebase closeout and all historical operation-private roots remain UNKNOWN. The child is still fixture-only and native credential resolution disabled. `liveAuthorization:false`; `authProofReady:false`.

Completed: the pending five-case PostgreSQL suite, five additional actual-boundary TLS/session cases, source reuse/hash checks and readiness reassessment. Fresh unchanged regression results: 11 bound Python, seven bound Node, 11 serialized handoff, eight readback, 12 coordinator, 13 bridge, 31 restoration, 11 extracted-auth Node and five auth-handoff Node cases pass (109 total); with both database suites, 119 focused cases pass. Backend lint/build/architecture, 25 governance safeguard tests, frozen-baseline/cross-repository consistency and whitespace gates are recorded for this update. No UI changed; browser is inapplicable.

Remaining/implementer: source-pin the actual native/current-state/private-root qualification requirements before requesting any operation; a fixture-only child is not a live launcher. Any material implementation expansion needs a prior owner decision. Remaining/owner: separate exact external authority and later acceptance. Next observable result: a bounded native/current-state qualification proposal with exact interfaces, unresolved facts, cleanup and authority requirements. No live operation is ready or scheduled.

R10 remains consumed. 3A remains open; accepted walkthrough 1A/1B/2A/2B = 4/8, R1 newly closed 0/27. Same-job Sandbox Checkout, signed settlement/failure/replay and owner acceptance remain outstanding. **No scope deviation.**
