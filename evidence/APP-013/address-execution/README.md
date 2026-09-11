# VO-2 mocked execution and uncertain recovery

Owner approved the proposed test-only policy: 8-second absolute deadline, three new attempts per session at least 30 seconds apart within existing account/tenant caps, exact-operation retry, no automatic refund/resend, and authorized audited recovery with supporting evidence. Baselines were backend 10a5198 and governance e29ab89, both focused branches fetched/aligned. Original dirty saved checkout preserved. This is one mocked execution/recovery section, not production verification or complete S1 admission.

## Implementation and limits

- AddressOperationPolicy has an explicit VO2_FIXTURE_8S_3_ATTEMPTS_30S version. No live settings/rates added. Absent execution version retains VO-1 behavior and its previous policy hash. Invalid versions refuse. New VO-2 reservations enforce three session operations and 30 seconds since the latest reservation, including cancelled/uncertain operations; account/tenant money and request caps still apply across sessions/months. Reservation time comes from a fresh database clock after locking, not transaction-start time.
- The new local-only migration adds nullable executionDeadline. Existing VO-1 claims have no deadline and cannot be used to execute VO-2 work. A claim writes the earlier of database-now plus eight seconds, policy expiry and session expiry, before transaction commit. Database time is read as epoch milliseconds to avoid timezone-sensitive raw timestamp decoding.
- AddressOperationExecutor invokes only an explicitly injected FIXTURE_ONLY callback after the claim transaction commits. It snapshots request identity, enforces the remaining deadline, aborts on timeout and ignores late output. Invalid/backward local time refuses. A lost claim acknowledgment, duplicate/orphan claim or reconstruction never invokes again. A completed OBSERVED transaction is required before returning a candidate. OBSERVED is a local execution observation, not address, billing or admission authority.
- Completion requires the exact attempt and current locked session/intent/policy. It cannot overwrite already-completed/recovered state; crossed deadlines become UNCERTAIN. Lost/failing result persistence leaves DISPATCH_CLAIMED or UNCERTAIN and all held costs intact. No automatic settlement, replenishment, charge inference or refund.
- Inactive recover accepts only operationId, attemptId and evidenceId. A trusted owner/admin context, matching active tenant/account, expired execution deadline and server-resolved evidence for that exact attempt are required. The only decision is RETAIN_LIABILITY. Audit captures actor, evidence reference and attempt; concurrent exact replay audits once, conflicts refuse, audit failure rolls back. No operator UI, real evidence provider, customer-supplied evidence authority, refund or dispatch permission is added.
- Existing protected correction transport adds requestId to its exact body. Propose carries a UUID; confirm/conditional-clear use empty requestId. Existing origin/session/header/request-budget protections remain. The single-customer loopback port uses a stable fictional shared account, a trusted transient intent binding and the durable ledger; provider mock work is no longer performed under a conversation lock. A still-live observed candidate can serve an exact lost-response retry. Missing process-local candidate after reconstruction is not recreated through another call. Retry copies and transient binding clear at session/24-hour expiry; distributed lifecycle cleanup remains VO-3.
- The existing customer page retains the draft on uncertainty and permits only exact retry or private reset, with confirmation disabled. Cooldown refusal retains fields. Editing or closing cannot release old liabilities. All addressVerified/admissionAuthorized/deliveryAuthorized/dispatchAuthorized flags remain false and county UNKNOWN. No live provider, credentials, website work, production registration, job or customer-data action.

## Evidence

Final backend: 96 passing suites / 1,835 tests, three existing skips. Build/lint/architecture/Prisma validation and focused formatting/diff checks pass. Eleven new executor unit cases cover successful observation, orphan/lost claim, timeout/late output, completion failure/fencing, clock validity and immutable request identity.

Eleven real PostgreSQL execution groups cover work outside locks, no redispatch, cooldown and three-attempt cap, held uncertain liability, service reconstruction, late observation refusal, result audit failure, authorized/evidence-bound recovery, exact concurrent recovery and recovery audit rollback. Existing thirteen VO-1 groups remain green. All migrations were applied only to the parent verifier's random disposable calldesk_org_* database, removed afterward. No production migration command ran.

The parent organization/customer/operator regression passes, including existing phone/address/payment-policy evidence and added mobile/desktop correction lost-ack, cooldown and uncertain-result flows. Unknown mock result and retry leave one UNCERTAIN row with the original held cost and no extra mock invocation. Mobile 390x844 and desktop 1280x900 have no page errors, storage or horizontal overflow; uncertain-state screenshots visually reviewed. These are fictional fixtures, not production identity/provider acceptance. Parent regression includes pre-existing fictional jobs; this section creates no job through verification.

Local artifact directory: /private/tmp/signmons-vo2-review-20260911. Committed execution/browser JSON summaries accompany this README. Screenshots: address-uncertain-mobile.png and address-uncertain-desktop.png.

Issues found and handled: initial compilation needed stable actor/tenant narrowing; one test assertion needed typed Jest matching for lint. First database proof exposed a four-hour raw timestamp shift in the deadline; epoch-clock reads fixed it and deadline/cooldown proofs now pass in the workstation timezone. One full Node/Jest run exited 139 without a reported assertion failure; unchanged rerun passed all 1,835 tests. No root cause is claimed for that tooling crash. Existing pg concurrent-query deprecation remains; no dependency changes or fresh vulnerability-audit claim.

## Review / reproduce

Inspect address-operation-ledger.ts (policy, deadline, completion and recovery), address-operation-executor.ts/spec, nullable migration, local-correction-port.mjs, protected transport/body change and existing journey/verifier changes. No CommunicationsModule, production controller, Google/Twilio live client or phone-accounting registration should change.

```sh
npm run build
npm run lint
npm run arch:check
npx prisma validate
npm test -- --runInBand
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-vo2-review PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
```

Review screenshots: lost success response is retried once without another call; an edited proposal during cooldown refuses without losing fields; unknown result shows no confirmation, retains the draft, and exact retry leaves liability unchanged. Database tests simulate elapsed cooldown/deadline by changing only fictional rows; unit tests exercise the actual eight-second timer with a controlled clock. No claim of OS process-kill or real provider timeout acceptance.

## Next / remaining gates

Stop review-ready. Next is VO-3 policy review and then approved freshness/revocation/cleanup implementation. Freshness durations and accounting/reference retention still require agreement before dependent coding. Production intent/evidence stores, multi-customer deployment, restore-time purge, source qualification, account/rate/budget/notices, real proof-to-job and financial settlement remain gated. Conservative RETAIN_LIABILITY recovery is not a finished provider billing reconciliation system.

APP-013 scope index remains 50%, accepted 0/12; onboarding local 50%, accepted 0/6; pilot accepted 0/12. No overall build percentage/ETA. No merge, deployment, production migration, provider setup, secret/IAM/billing change, real data, live verification or spending.
