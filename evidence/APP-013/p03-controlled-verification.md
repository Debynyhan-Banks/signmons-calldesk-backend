# P03 — controlled current verification, review-ready

Existing APP-013 / 2B, under owner-accepted P01 engineering contract. Entry backend f1534fc/governance 60621f9; both remotes fetched, feature tips reconciled, backend PR21 open. Owner accepted P02 and said “i reviewed, i agree with more data for timing, proceed.” Source card: governance APP013_P03_SOURCE_CARD.md, prepared before implementation. No scope deviation. Existing fixture paths, operator guards and unrelated saved-checkout changes preserved.

## Completed P03 checklist

1. **Distinct current phone evidence:** controlled-phone-proof.ts/.spec.ts and durable-verification.service.ts add a separate controlled policy/proof, not relaxed FIXTURE_ONLY validation. Only the concrete, account/service-bound Twilio adapter can supply the controlled writer. Successful durable CHECK binds tenant/session/phone digest, source account/service and immutable policy. Old phone-only/fixture receipts do not gain proof on replay. Expiry uses existing 30-minute maximum bounded by session; final reads use database time. Explicit existing phone revocation clears both kinds and cannot be undone by changing the phone back. twilio-verify.adapter.ts exposes only its non-secret binding for server composition.
2. **Existing durable address budget reused:** address-operation-ledger.ts/.spec.ts and address-operation-executor.ts add separate controlled entry points requiring P02 authority on each stage. Original fixture entry/context checks remain. Account/tenant/session held-cost counts, claim ownership and unknown liability remain durable. Controlled mode limits the session to two requests, each with an eight-second maximum deadline, never automatic resend. The different execution-policy marker prevents fixture alias reuse. Final observation checks current policy hash/approval, operation/attempt/request/intent/revision/account/session, state and deadline.
3. **Request-local semantic connection:** controlled-intake-verification.service.ts/.spec.ts loads trusted customer-confirmed input, verifies current phone, claims budget, calls the existing Google OAuth transport outside the transaction, and reuses shared address/county parsers. A correction returns only the existing candidate allowlist and jobCreated=false. Unknown/outside/late input refuses. Successful semantics yields only a single-use transaction-check closure to the trusted caller: policy/source/input edits, expiry, missing proof or changed operation refuse. The closure is unusable after return, and skipping or swallowing a failed check cannot yield CONSUMED.
4. **Local validation:** full unit/regression gates and the existing disposable database harness passed. scripts/verify-address-operation-ledger.mjs now covers controlled concurrent claims, restart/no reclaim, revoked/changed policy, two-request cap/held uncertainty, and connected encrypted phone CHECK → synthetic Google transport/parser → actual final PostgreSQL transaction. Provider-content sentinel checks on conversation data/audits passed. No live provider request occurred.

CONSUMED means the internal callback completed its check, not that a job was created. This package has no job writer or customer endpoint. It stores no Google body, county/verdict/responseId, provider-content digest, coordinates or permanent Google-certified claim. Correction content remains transient; P05 must apply the already approved presentation/lifetime rules. The shared fixture current-proof-admission.ts and its old receipt remain untouched.

## Reproduced validation

- npm run lint: passed after correcting one formatting-only indentation error during iteration.
- npm run build: passed, locked Prisma 7.10.0 generated client.
- npm test -- --runInBand: **115 suites passed, 1 skipped; 2,224 tests passed, 3 skipped**. Twenty-six new unit cases; skips are not passes or new acceptance.
- node scripts/architecture-check.mjs: passed.
- npm audit and npm audit --omit=dev: **zero vulnerabilities reported**; not closure of unrelated operational risks.
- node scripts/verify-staging-address-reservation.mjs: passed. Uses only a generated calldesk_org_<random> database over the local Unix socket, applies migrations there, checks controlled and legacy caps/execution/phone regressions, then drops that disposable database. No live DATABASE_URL, cloud migration or provider credentials used. Detailed run output: /private/tmp/signmons-p03-database.log (ephemeral local diagnostic, not a retained provider result).
- Governance frozen baseline, full consistency, 21 governance regression tests; backend cross-repository guard and both whitespace checks passed.
- Browser/UI QA not applicable to this unregistered backend connection; no screen, route or parser registration changed. P05 actual browser flow and P06 live acceptance are still required. No historical screenshot or prior live test is counted here.

The connected database test uses actual encrypted ledger and address tables/transactions but substitutes phone spend-admission and provider ports. Existing phone budget/stop regressions run separately in the same harness. It is not proof of production pricing, OTP consent, real account configuration or live verification. Actual approved composition must supply the matching policy, adapter, spend approval, authority and trusted current-draft reader; no permissive test port is registered in the app.

## Remaining / safety boundary

- **P04:** supply actual current-draft/organization/payment reader and atomic version2 job writer, session/edit invalidation, safety/exception handling, unique/replay/rollback checks. Exact committed receipt lookup must happen before invoking P03, so a lost successful response never spends on validation again. An uncommitted request cannot restore Google evidence from storage; any further attempt needs explicit customer action and remaining cap.
- **P05:** customer/ingress wiring, correction confirmation/revision and truthful created/not-booked/exception/restart UI. No alternate demo or new package.
- **P06:** owner-authorized actual identities/configuration, release/migration, fresh caps/window and connected live evidence. No merge, deployment, provider configuration, charge, text/email/call or real customer/job/appointment change occurred here.

Rollback: leave the controlled composition absent/disabled or revert this focused code commit. Existing fixture entry stays fixture-only, default construction refuses, and prior held liabilities are not refunded or reset. No production rollback is needed.

## Timing and review

Start 2026-09-13 **14:16:08 UTC**; implementation/full validation checkpoint **14:32:13 UTC**, **16 minutes 5 seconds** before final documentation/Git closeout. Agent wall time includes local validation waits; human productive-day effort and later owner review duration are not inferred. No external blocked time during this run. P02's full recorded execution was 8 minutes 57 seconds; two packages do not establish throughput for larger integration/voice work.

Final pre-commit gate rerun completed by **14:35:56 UTC**: **19 minutes 48 seconds from start**, including the final pre-reservation address-input refusal check and repeated lint/build/full tests/architecture/disposable database checks. Documentation and Git closeout follow; these checkpoint timestamps are not human effort estimates.

P01/P02 accepted: **2/60 (3.3%) of the remaining-plan package ledger**, not whole-app progress. P03 review-ready, owner acceptance pending. Walkthrough stays **3/8 (37.5%)**. Original **60–84 productive-day Release A planning baseline** remains low-confidence pending at least five measured packages; no denominator/scope change.

Review steps:
1. Review the four new controlled-phone/verification source/spec files and five existing source/spec edits in PR21, especially separate fixture guards, current-policy checks, no-proof replay and final-check lifetime.
2. Review the extension to scripts/verify-address-operation-ledger.mjs and rerun the commands above. Database command requires the existing local socket PostgreSQL server; it creates/removes only its generated test database.
3. Review coordinated governance source card, pointer/handoff and daily ledger: P03 R, P04 next, no live/job acceptance awarded. Run SIGNMONS_GOVERNANCE_REPO=/private/tmp/signmons-2b-bootstrap-gov node scripts/check-governance-baseline.mjs from this backend; governance consistency uses SIGNMONS_BACKEND_REPO=/private/tmp/signmons-2b-bootstrap-backend.
