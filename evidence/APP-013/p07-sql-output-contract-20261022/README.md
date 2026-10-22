# R1-W01 / APP-013 / 3A / P07 local SQL/output correction completed

October 22, 2026. Implemented and locally tested; no live runtime/payment acceptance.

## Authority and exact source

Debynyhan Banks approved “Alternative 1 for local correction and real SQL tests only,” proposal `APP013_P07_SQL_OUTPUT_CONTRACT_REUSE_PROPOSAL_20261022.md` at governance `b7f45fcc53e7a977da205d56c289ae4b9e2a68b3`. Decision recorded before implementation at `a16513f0f9433adebdf3c978a6bfbfefdf4fd55a`; starting backend `17bd56b3f4e88f2cf879b077eb62bc7ec588dd03`. Prior operation `abff0262-3504-4f92-b49d-5c5dea238cdb` remains consumed and contained before mutation; immutable source/manifest/stop/closeout still match.

Fresh disabled package `/private/tmp/p07-repaired-runtime-readiness-20261022-sql-contract1`: plan `4bb26b9b-cd41-4bbb-a62a-5aedfd4f82bb`; packet `c9622a7d-7aa0-4a27-ab75-e9bc56f21cc0`; operation `b8d2ac94-3310-4f84-b36a-8495cc919097`.

| Artifact | SHA-256 |
| --- | --- |
| Manifest | `72a25f79a4f0d3275016baa4e5fd715f7f5d58d9b5ded309e5f8024df75933c3` |
| Controller | `093a69824feef7f0885680ba92685927ca5e8259c0752608ca2e84f3abc285ae` |
| Controller tests | `368bae0f09e758c5587dfea16429490e43bc69302bec829481c6012da451f30d` |
| PostgreSQL tests | `c8051318d13c482cd10c8e404dd615274b81ea24188896f751194f4fbfb8f68c` |
| Reused diagnostic controller | `95bcee7863dedca6146cb0349f73ba5aa69b06549f7c4287e1634ce54ff0fe42` |

Attached zero-context patches reproduce the tested fresh controller/tests from unchanged guards1 plus the existing total-output diagnostic test harness. Plan/manifest contain sanitized source metadata. No actual credential, raw/encoded live account value, query row or provider payload is retained.

## Completed finite checklist

1. Reused preflight query text and classifier AST exactly match the already-proved diagnostic. Three tagged/null-safe rows, explicit counts and `0`/`1` flags, repeatable-read READ ONLY and ROLLBACK. Exact identity/role/job/payment/calendar/admission/account/charges gates remain fail-closed. Account field decoded only in memory; sanitized receipt unchanged.
2. Role readback now has a tag/count and explicit stable flags in a read-only transaction. Exact login/no-inheritance/no-elevation/limit6/expiry-no-later-than-work-end/zero-memberships/zero-owned-relations checks retained. Grant fixture and runtime writes unchanged.
3. Real PostgreSQL regressions reproduce both consumed-source defects on healthy synthetic state, then verify corrected preflight and role readback. Actual `db_preflight` query → parser → sanitized receipt passes; failed real SQL output cannot save success.
4. All 60 prior controller acceptance cases retained; only affected SQL protocol fixtures aligned. Two controller tests added for approval pin and malformed/legacy role output. Real SIGINT/SIGTERM/PTY restoration/deadline/concurrent reservation/recovery/private-mode cases retained.
5. Fresh identities, immutable pre-implementation approval pin and private source/hash inventory verified. No binding, live approval, attempt or mutation/provider receipt; all live modes refuse before input/access.

AST comparison permits changes only in existing `local_check` (approval pin), preflight classifier/wrapper and role readback within `provision_database`; only new functions are the role SQL formatter and validator. All other controller functions are AST-identical, including completed deadline/signal/cleanup guards. Three Node helpers and role grant SQL are byte-identical. No application/image/schema/dependency change.

## Validation

`python3 -B -m unittest -q test_controller.py test_postgres_contract.py`: **80/80 pass** — 62 controller and 18 real PostgreSQL methods, with multiple negative subcases. No fabricated database rows substitute for real-SQL positives.

Real SQL covers healthy/missing/duplicate/null records; changed state/deletion/foreign tenant; payment/calendar activity; bound/invalid/null policy; account format/hash/charges; actual held synthetic P06 session and role collision; malformed/missing/extra/wrong-tag transport; healthy/absent role and each unsafe flag/limit/expiry/membership/ownership. Consumed queries fail healthy real output exactly as expected. These role metadata tests do not replace existing grant-map proof or establish live permissions/customer capability.

The existing disposable harness uses a short private Unix-socket path, TCP disabled and synthetic data. Initial startup failed before SQL; short-path setup and cleanup-on-startup-failure were added. An intentionally held P06 session initially shared the diagnostic application label; its own synthetic label preserves the zero diagnostic-session assertion and proves active P06 session refusal. No gate/test was weakened. These were test-setup issues only.

The passing fixture stopped/reaped its server and removed its directory. Independent local process/path check confirms **zero matching fixture server processes and zero fixture directories**. No live database/provider connection. Python AST/Node helper syntax/private modes/exact inventory/hashes/no-action pass; run/recover/retire each refuse `P07_REFUSED_WINDOW_NOT_BOUND` before input/access. Ten files including manifest mode0600, directory0700; no binding/approval/attempt.

Repository frozen-baseline/consistency/25 safeguards, backend governance/architecture and whitespace checks apply to this evidence checkpoint; final results recorded below. No new app build/lint/full runtime or browser/provider QA is claimed for this private-controller-only correction. Live raw query values remain intentionally unavailable; passing synthetic SQL does not prove every current live predicate passes.

## Remaining and next observable result

Local two-interface correction complete. Tenant binding remains live-demonstrated and contained. Runtime/disabled-webhook readiness and P08 authentic same-job Sandbox settlement/owner 3A acceptance remain open. Owner Debynyhan Banks supplies fresh attended Eastern availability of at least 90 minutes; implementer binds/retests and presents the exact operation for separate external approval. No old command/window/allowance revived; this unbound package must not launch.

Accepted milestones 1A/1B/2A/2B; **0/27 newly closed R1; 6/60 legacy; 4/8 walkthrough; 0/13 intelligence** unchanged. No live database/role/grant, secret/IAM, Stripe/destination/event, deployment, payment, booking/message/customer, merge or push action. **No scope deviation from the approved two-interface local correction.**

Final repository validation: frozen-baseline/cross-repository consistency pass; **25/25** governance safeguard regressions pass; backend governance baseline/architecture and both whitespace gates pass. Review patches reproduce the exact tested private source; all 60 prior controller test method names are retained. No acceptance/queue/criteria change.
