# APP-013 / 3A / P08 — approved no-retry amendment local result

**Implemented and locally tested; no external qualification performed.** Owner approved option 1 in governance `APP013_P08_NO_RETRY_TRANSPORT_CHANGE_REQUEST_20261101.md` with “i approve”. The section card was completed before runtime edits, including a successful synthetic read-only SQLite/concurrent-writer experiment. Verification timestamp: 2026-11-01 14:36:48 UTC.

Backend base d5f1f876e8f17f8236d2262d1856a6fa323a86a4; governance base 996cc7fb5be906ddf64d1d337c7fa6dc24a3a001. Both focused checkouts remain on codex/p06-r08-recovery-20260918 with uncommitted work. Saved dirty changes, including AGENTS.md and earlier evidence, were preserved. No commit, push, merge, SDK patch or deployment occurred. Remote configuration was inspected; remote tips were not fetched in this local-only section.

## Exact implemented change

The existing single runtime module now accepts version 2 plans with zero CLI, six HTTPS and one local cached-token reservation. Application/provider SQL, mutations and retries remain zero. The contract hash binds this explicit amendment and the supported runtime: macOS, Python 3.14.2, SQLite 3.51.1. Old version/limits/source/authority bindings refuse. No gcloud subprocess or OAuth refresh path remains in this module.

The six requests are project GET, two exact role GETs, the unchanged two permission-test POSTs and the API Keys service GET. Reused project/role parsers and twelve permission names remain strict. No generic URL/command input, extra permission or resource was added. Proxy discovery is disabled explicitly. Each response is bounded, closes, and has no retry or redirect; HTTP 401/429/503/302 and connection/total-read timeout cases are covered. A disabled service is still a blocker, never permission to enable it.

The cache load is reserved before any config/cache read. It uses only the fixed default SDK root, exact active named configuration, owner/default universe and project. Unknown configuration sections/options, inheritance, credential/endpoint/proxy/environment overrides are refused. It never invokes the SDK's resolver, constructors, refresh, metadata, ADC or login.

Only the exact owner's token, expiry and restriction fields are selected from existing access_tokens.db. No credentials.db, refresh/RAPT/ID token or other account query. Missing/expired/unsupported token, schema, ownership, permissions, link, journal/WAL/SHM or configuration state refuses before HTTPS. Token expiry must extend beyond purgeEnd. Cache schema evidence is pinned to the inspected SDK; current real-user compatibility is UNKNOWN.

Read-only SQLite uses mode=ro/immutable and an existing read-only descriptor holding nonblocking POSIX shared locks over the Unix SQLite lock bytes. Rollback-journal header, no sidecars, exact schema, query allowlist/SQLite authorizer, bounded query work and stable file/config readback are required. Tests demonstrate refusal of an already-active writer, prevention of a separate SQLite writer during the read, no byte/mtime/directory changes, rejection of path/config replacement, SQL write/DDL/attach/extension/other-secret denial, and lock release after exceptions/timeouts. This covers normal Unix SQLite locking, not malicious same-owner raw writes or unsupported filesystem/VFS behavior. Unsupported state stops; no cache conversion/copy/migration is performed.

The existing operation lock, single attempt, journal, fixed deadline offsets, private inventory and independent closeout remain. Independent closeout never constructs native transport or loads credentials. Pending/unsettled interrupted events remain unconfirmed rather than being replayed. Token references and database/response handles are cleared/closed; no secure memory-erasure claim. The original module, tests and manifests are preserved as non-entry `.txt` rollback artifacts under `before-no-retry-amendment/`.

## Source and fresh verification

- Runtime SHA256: `861b0f549488fa3c281d2c4a7b3807c6c83bfa6f2a4d0a535367d2c2f0164b4d`.
- Runtime manifest SHA256: `dc687b5bc36264c57c75154122d406393d2e3711853332e5e57112c881ec9597`.
- Separate test manifest SHA256: `007d40ec05a27e755c606b1f1e13054462ea01e6fe90194e503afbd0a339df53`.
- `python3 -B evidence/APP-013/p08-narrow-access-check-local-20261101/source/test_access_check.py -v`: **49 PASS**. Earlier amendment development runs were 32 and 46 PASS; final 49 follows the last runtime/test edits. Applicable prior authority, parser, interruption, concurrency, cutoff, cleanup and privacy cases remain; obsolete CLI-child proof is replaced by no-CLI/old-plan refusal and cache/native proofs. Four SDK diagnostic cases remain as regression evidence.
- Actual NativeIO + run entry was exercised with a synthetic disk cache, mocked committed-document reader and injected HTTP opener. It produced exactly one cache load and six serialized requests; local-capability native refusal and absent real commit refusal were also tested. This does not establish real committed approval, live credentials or provider behavior.
- `python3 -B evidence/APP-013/p08-narrow-access-check-local-20261101/source/access_check.py --check-source`: integrity PASS; `ready:false`, `localTransportReady:true`, reason `EXTERNAL_QUALIFICATION_NOT_AUTHORIZED`. The local transport flag is not execution authorization or current access qualification.
- Separate current test/runtime/21 SDK review hashes, Python syntax and evidence whitespace PASS. Runtime manifest still has exactly one runtime module; test provenance is separate.
- Backend governance-baseline with resolved governance, architecture and git diff --check PASS. Governance frozen baseline, docs consistency with resolved backend, 25 safeguard tests and git diff --check PASS. Final documentation changes receive the same baseline/consistency/whitespace checks.

No TypeScript build/lint, application/PostgreSQL or browser result is claimed fresh: those interfaces did not change. New SQLite fixture tests are included in the 49-case focused suite. All credential material and request/response values in tests were synthetic; real user config/cache and provider endpoints were not accessed. Public method documentation and installed SDK source were read.

## Finite closeout and next observable result

Approved checklist 1–5 is complete: source/contract/opening inspection; same-module amendment; boundary/negative/concurrency/recovery proof; source/manifests/checks; result/readiness record. See SECTION_CARD.md for prerequisite-by-prerequisite status and owners.

Remaining, implementer/owner: pin the reviewed source in commits and assemble a separately approved qualification-only operation with the exact version-2 plan, operation ID, absolute window and cleanup boundaries. No such committed operation or scheduled window exists now. Actual default config/cache compatibility, token lifetime, owner permissions, roles and API availability remain UNKNOWN; the native qualification must refuse rather than repair or refresh them. Owner/provider administrator handles any reported access/configuration blocker under separate authority. Billing/runtime/CHILD/Firebase/job/key/payment/full qualification remains excluded and unresolved.

The next observable result is a source-pinned, separately authorized six-read qualification result or a specific refusal—not a broad replay or payment advance. 3A stays open; accepted 1A/1B/2A/2B **4/8**; R1 newly closed **0/27**; R10 consumed/no retry. No provider/configuration/customer action, charge or spending. **No scope deviation beyond the owner-approved amendment.**
