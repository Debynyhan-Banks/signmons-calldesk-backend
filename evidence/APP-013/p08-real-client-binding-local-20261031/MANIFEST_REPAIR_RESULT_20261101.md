# APP-013 / 3A / P08 — approved manifest repair verified

Owner approved the exact repair in governance `APP013_P08_QUALIFICATION_READINESS_STOP_20261101.md` with “I approve lets proceed” on November 1. Verification completed by 2026-11-01T12:58:12Z. Backend entry `d5f1f876e8f17f8236d2262d1856a6fa323a86a4`; governance entry `996cc7fb5be906ddf64d1d337c7fa6dc24a3a001`; prior uncommitted evidence and owner `AGENTS.md` changes preserved.

The runtime `source/source-manifest.json` is restored byte-for-byte to HEAD, retaining its six original filenames, hashes, source locks and disabled status. SHA256: `88ae97093da04e6273638a4507372ffb9a09ea6dec00e6584ad8c9d152599632`. The two unchanged PostgreSQL test files are now recorded separately in `source/postgres-test-manifest.json`, SHA256 `668d800fe4f0888019c6606918fecf8288e18ae1233c9f22631188b118edd70a`, with status `LOCAL_TEST_PROVENANCE_ONLY`. No source validator, runtime implementation or test expectation changed.

After both manifests were finalized, direct invocation of the unchanged `bound_handoff.verify_sources()` passed. Independent hash verification passed for all six runtime-manifest files and both test-provenance files, including the handoff module's own hash. The exact focused command then passed all 11 cases in 1.253 seconds:

```sh
python3 -B evidence/APP-013/p08-real-client-binding-local-20261031/source/test_bound.py
```

Current repair gates: backend architecture, frozen baseline, cross-repository governance/docs consistency, 25 governance safeguard tests and both whitespace checks pass. Earlier PostgreSQL/TLS, broader regression, lint and build results remain historical and were not rerun for this provenance-only repair. Browser testing is inapplicable; no UI changed.

The `MANIFEST_SHAPE` blocker is resolved without weakening the gate. The earlier failed final-bundle claim remains disclosed in the stop record; the present result supersedes its pending-repair status. Qualification planning resumed in governance `APP013_P08_NATIVE_ENTRY_QUALIFICATION_PROPOSAL_20261101.md`. Actual native credential/approval/transport binding and operation-private-root readbacks remain unproved; current external facts UNKNOWN. No credential, provider/database operation, runtime/payment action, merge, push or deployment occurred.

Completed checklist: restore exact six-file manifest; separate unchanged test hashes; actual final source gate; 11 focused cases; repair gates; corrected handoff and resumed qualification proposal. Remaining: owner decision on the proposed material native-entry integration, selected local proof, separately approved current-state qualification/external operation, same-job Sandbox settlement/recovery and owner acceptance. R10 remains consumed; 3A open; accepted 1A/1B/2A/2B 4/8, R1 newly closed 0/27. **Previously disclosed manifest drift repaired under explicit owner approval; no further scope deviation.**
