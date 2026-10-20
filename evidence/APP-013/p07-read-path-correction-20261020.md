# APP-013 / 3A / P07 local read-path correction — October 20

Status: **implemented and locally mocked-tested; not live-demonstrated, execution-approved or owner-accepted as a payment outcome**.

Owner explicitly approved only the local split-read correction: direct restricted CHILD connection for Job/Tenant reads and administrator read-only exact-job Payment/CalendarOperation absence checks, with no grants or memberships. The selected 4:00–5:15 p.m. Eastern block is availability, not launch authority.

## Corrected behavior and evidence

The expired repair3 source connected as administrator and attempted SET LOCAL ROLE, despite the proposal requiring a direct restricted connection and the reviewed zero-membership boundary. Its query also included two tables intentionally denied to the intake role. The new local copy resolves those diagnostic mismatches without changing P06 rights or application/image source.

Private source: `/private/tmp/p07-read-path-correction-20261020`, mode 0700 and files 0600. Its entry point always returns `P07_LOCAL_CORRECTION_ONLY_NO_EXECUTION` and exit 2, including with --run. Historical IDs/window/hash bindings inside copied mocked fixtures confer no execution authority. No owner-approval, attempt, stop or result receipt was created.

The correction reads only numeric child URL version 2 in memory when a later exact operation authorizes it; validates the documented schema=public/sslmode=verify-full connection format and preserves certificate/hostname validation through the reused Node pg transport; uses the restricted role directly; verifies database, current_user and session_user; separates forbidden-table absence checks into an exact-job/tenant administrator read-only transaction; and rolls both transactions back. Receipts contain only bounded facts. Connections have separate point-in-time snapshots; no cross-connection atomicity is claimed. Future payment actions must revalidate their transactional guards.

`/opt/homebrew/bin/python3 -B -m unittest -v test_controller.py` in that local directory passed **25/25 mocked tests**. These retain all 19 prior tests and add direct-role/secret-argv checks, malformed/foreign credential refusal, forbidden-table separation, identity/job refusal, existing payment/calendar refusal and entry-point refusal. The inherited happy-path mock now fixes its own test clock inside its original fixture interval; actual expiry checks are retained. Three additional Node helper tests pass for certificate/hostname validation, cleanup after query failure and unexpected-result refusal (`node --test test-runtime-read.mjs`). No Cloud, Stripe, Firebase or real database connection ran.

Manifest SHA-256: `99c00b8b59b50b7069adc018dd26b724c282abd547e5b2ab0c0c6b6b515b07f4`.

| Local source | SHA-256 |
| --- | --- |
| README.txt | `0b6f810ab71865b161362aa03bfe782e54140b7e6e96a6c6f553dd3c71d8658b` |
| controller.py | `77c60231372e8eb6688aad2b80c17fb96833f205b510532e1b8b057df234ad15` |
| db-closeout.mjs | `81e6c2c324dbe6e0e1a649e0f131e1c84bf1feb9bc41f96e93bfc400c57c1dec` |
| db-runtime-read.mjs | `15d2817fda86329b20e80a281bb6eebf3ea13429570c1b0088b130d9afed4b11` |
| firebase-read.mjs | `7c31677a79afb719b070d1b0c764c0d6442053996982dbdf77a72085edf262dd` |
| test-runtime-read.mjs | `1d8b8c731671009f9f58e81ba4cd36e4b3a0652528fde52376034599f340e860` |
| test_controller.py | `82aac5d30035cea9d6346685364b9b3211cd1392b9130c7a65c0dccc8b9dc357` |

[Archived source-only correction diff](p07-read-path-correction-20261020.patch), SHA-256 `2e84861ff94329c89f02761e332f5fcdb17df162357bd118390ff23a15191c81`. This is not an operation package or runnable launch authority. All five old manifest source hashes still match; the consumed/expired package and receipts are unchanged.

## Newly demonstrated prerequisite — not repaired or approved

The P07 candidate proposal points DATABASE_URL to the intake-only role. Current source requires Job policy/pricing UPDATE, Payment reads/inserts/updates and StripeEvent reads/inserts/updates; reviewed intake grants intentionally forbid these. Source: `src/jobs/job-payment-policy.service.ts`, `src/payments/payment-requests.service.ts`, `src/payments/stripe-webhooks.service.ts`, `scripts/fixtures/p06-runtime-role-review.sql`, `scripts/verify-p06-runtime-role.mjs`. No fresh live ACL state is asserted.

Therefore neither this correction nor a health check establishes a usable payment runtime. No new external package is ready. Governance `APP013_P07_PAYMENT_RUNTIME_ACCESS_CHANGE_PROPOSAL_20261020.md` describes the unimplemented permission-plan change and required real disposable restricted-role proof. Preserve the P06 role and its negative tests. No new grants, credentials, secret versions, deployment or payments are authorized.

R1-W01 / 3A remains open. Counts: **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. Scope: narrow local correction explicitly approved; broader payment-runtime prerequisite proposed and unapproved. No retrospective no-deviation claim for that prerequisite.

## Checkpoint validation

Governance frozen-baseline and cross-repository documentation consistency pass, as do all 25 governance safeguard regressions. Backend governance baseline, architecture and both repository whitespace checks pass. These are current local/helper/documentation results only; earlier application/full-runtime suites were not rerun or claimed as fresh.
