# Signmons Backend Execution Board

## Durable verification reservation and observation (2026-09-10, latest review-ready)

Implemented inactive session-bound reserve/invoke/finalize around the Verify adapter, with no transaction spanning the mocked provider call. Encrypted bounded ledger and atomic audits preserve attempt identity. Exact replay returns the saved result or unresolved reservation without invoking again; changed payload refuses. Check SID comes from the matching saved start, not the customer. Failed finalization retains unknown invocation count and UNRECONCILED potential cost; no automatic reservation reclaim or resend.

Evidence: backend evidence/APP-013/durable-verification/README.md and nine-group database summary. 18 new unit tests; full backend 1676 passing / 3 existing skips; lint/build/architecture/Prisma, two clean backend audits and existing full browser regression passed. Disposable database removed. No new UI, actual delivery, process-kill or reconciliation claim; all authority flags remain false and local phone fixture stays separate.

One START/five CHECK local bound is not a production budget. Reserve/observe audit rows share attempt ID and must not be counted twice. Rate/account/service binding, OTP opt-in, shared traffic limits, monetary cap, recovery and admission proof transfer remain open. Next after review: durable verification opt-in and usage-budget admission prerequisites, mocked/inactive; no live sends or configured costs. No schema/package/migration, production registration, real data, merge/deploy, IAM/secrets/billing or charges.

APP-013 sole Now, Next empty, FE-014 paused. Progress unchanged: APP-013 50% scope coverage / 0 of 12 accepted; onboarding 50% local / 0 of 6 accepted; pilot 0 of 12 accepted. No overall engineering ETA.

## Inactive Verify adapter and cost boundaries (2026-09-10, latest review-ready)

Owner approved the Twilio recommendation and requested competitive/profitable pricing awareness. Implemented one unregistered injected-client adapter: strict tenant/account/service/phone/SID binding, SMS start/check mapping, sanitized outcomes and no automatic retries. APPROVED is provider evidence only; all application authority flags remain false. No live client/configuration, provider calls, UI/route/persistence changes, secrets, billing or charges.

Evidence: backend evidence/APP-013/twilio-verify-adapter/README.md. 42 new tests; full backend 1658 passed / 3 existing skips, lint/build/architecture/Prisma and two clean backend audits. Installed SDK tested with network-free HTTP client; maxRetries:0 defaults to 3, so autoRetry:false is the effective guard. No new browser/UI QA claim; none required for inactive adapter-only change.

Usage output records attempted SDK calls and UNRECONCILED billing, not billable SMS or implemented cost enforcement. VERIFICATION_UNIT_ECONOMICS.md defines per-tenant/cohort costing, versioned rate inputs, failure/retry attribution, reconciliation and margin-planning requirements without setting prices or margins. Missing cost is unknown, not zero.

Stop for review. Next bounded connection: durable request reservation/finalization and deduplicated usage observations using mocked provider outcomes. Opt-in, spend circuit breaker, recovery, live activation and admission transfer remain gates. APP-013 sole Now, Next empty, FE-014 paused. Percentages unchanged: APP-013 50% scope / 0 of 12 accepted; onboarding 50% local / 0 of 6 accepted; pilot 0 of 12 accepted. No overall engineering ETA or production authority.

## Phone verification provider recommendation (2026-09-10, latest review-ready)

Read-only provider review recommends Twilio Verify v2; governance PHONE_VERIFICATION_PROVIDER_DECISION.md records sources, costs and recovery differences from fixture. Next after review: inactive injected-client adapter and tests, no live calls or configuration. Standard test credentials do not support Verify; 404 is not approval; durable network recovery and OTP opt-in remain required. No runtime or acceptance change. APP-013 sole Now, Next empty, FE-014 paused; percentages unchanged. No release, secrets, billing, real data or charges authorized.

## Local phone-code journey (2026-09-10, latest review-ready)

Implemented the approved first local phone slice: request/check/resend/clear/status in the existing fictional customer browser, encrypted durable session-bound state, exact version/retry handling, atomic audits and database-backed per-destination request/attempt limits. Explicit number change revokes prior test proof without staff verification. Lost-response retry writes once. Deterministic code 123456 is a labeled fixture; FIXTURE_VERIFIED never grants phoneAccessAuthorized, bookingAuthorized or deliveryAuthorized. No job verification flag or admission authority changes.

Evidence: backend evidence/APP-013/local-phone-verification/README.md, ten database proof groups, browser summary and mobile/desktop screenshots. 1616 backend tests (18 new), 170 UI tests, lint/build/architecture/Prisma, four clean audits and full local browser/database proof passed. Initial sandbox socket refusal and advisory-lock void-result issue were resolved and final gates passed; existing toolchain/pg warnings remain. Fictional database removed; original dirty checkouts preserved.

Local QA policy only: 5-minute challenge, 10-minute test proof capped by session, 30-second resend cooldown, 3 requests/5 checks per session and per tenant/destination over one hour. No approved production thresholds or provider semantics inferred. Optional transport is fixture-only, with no module/controller registration, package/schema/migration changes or live sending. No provider, real data, merge/deploy, IAM/secrets/billing or charges.

Stop for review. Next is the real verification provider contract/selection and activation plan, not silent activation; define actual delivery/check semantics, costs, limits and channel behavior before production evidence or admission transfer. Address/coverage and existing human-reviewed admission remain distinct unfinished connections. APP-013 sole Now, Next empty, FE-014 paused. Progress unchanged: APP-013 50% scope coverage / 0 of 12 accepted; onboarding 50% local / 0 of 6 accepted; pilot 0 of 12 accepted. No overall engineering ETA.

## Automated verification contract mapping (2026-09-10, latest)

Source audit completed at 511cd1a; canonical findings and proposed local phone challenge slice are in governance AUTOMATED_VERIFICATION_CONNECTION.md. Existing transport is not OTP, placeholder addresses are not validation, and routing fallback is not coverage evidence. No runtime changes or acceptance credit. Next proposed: connected local request/check/resend/correction with durable session-bound proof after explicit contract/policy definition. No live sends, provider activation or release; APP-013 remains sole Now. Stop at mapping review.

## Approved automated verification MVP decision (2026-09-10, current)

Owner approved documentation before implementation: automated phone one-time-code verification, address autocomplete/validation and configured service-area checks, followed by existing payment/availability gates. Mandatory operator contact/address confirmation is superseded; human help is an exception. Phone access is not identity or messaging consent; payment is a separate safeguard. Existing human-reviewed admission is not silently removed. Canonical requirements and acceptance cases are in governance CALLDESK_MVP_PLAN.md, section "Approved automated verification MVP decision".

Next: inspect/reuse contracts and bound the automated connection, including expiry, abuse controls, correction and retry. No runtime changes, provider selection/configuration, live codes, charges or release authorized. APP-013 sole Now, Next empty, FE-014 paused. Progress unchanged: APP-013 50% scope coverage / 0 of 12 accepted; onboarding 50% local / 0 of 6 accepted; pilot 0 of 12 accepted. No overall engineering ETA.

## Reviewed preferred service window (2026-09-10, latest review-ready)

Owner reviewed b61bb55 and approved continuing the preferred-window section. Added local operator save/reload for a customer-stated preference, never availability or a booking. Exact job version, acknowledgment, active tenant and non-impersonated owner/admin/dispatcher required. Shared tenant/job locks and CAS atomically write preferredTimeText plus private review/audit metadata; preserve pricing, payment/intake snapshots, status and appointment fields. Refuse jobs with payment or scheduling activity. Exact same-actor retry writes once; fresh-version correction is explicit and audited.

Evidence: backend evidence/APP-013/preferred-window-review/README.md, summary and focused desktop/mobile screenshots. 1598 backend tests (25 new), 170 UI tests, lint/build/architecture/Prisma, four clean audits and local browser/DB proof pass. Parent includes 12 organization/intake, eight admission and 12 browser groups, including five new preference checks: lost-ack exact retry, real audit rollback, selective blocker removal, stale/foreign/role refusal and concurrent correction once. Fictional records/database removed. Existing toolchain/pg deprecation notices remain documented.

New route is unregistered in production. Plain text is not parsed to a date, timezone or reserved slot; payment/contact/address blockers remain and both booking/delivery authority stay false. No provider/payment/booking/send action, schema/package/migration, merge/deploy, real data, IAM/secrets/billing or charges.

Stop for review. Next priority: inspect contact/address validation and coverage evidence and define what proof can clear those blockers, not a checkbox-only verification claim. Full S2 booking/confirmation and production rollout remain open. APP-013 sole Now, Next empty, FE-014 paused. Progress unchanged: APP-013 50% scope coverage / 0 of 12 accepted; onboarding 50% local / 0 of 6 accepted; pilot 0 of 12 accepted. No overall engineering ETA. Sales/advisor and website import remain outside MVP.

## Approved payment-policy prerequisite (2026-09-10, prior checkpoint)

User explicitly approved owner/admin organization payment-policy setup after the missing authoritative setup was identified. Completed one local prerequisite: fixed USD fee/deposit draft, separate versioned approval, and explicit approved-snapshot attachment to a human-reviewed CREATED job. Tenant settings preserve other configuration; CAS and audits protect save/approval. Shared tenant/job locks, exact versions, pristine-job checks and atomic job/audit binding protect attachment. No auto-waiver or implicit approval; exact retry only. Later drafts/approvals do not rewrite existing job snapshots.

Evidence: backend evidence/APP-013/organization-payment-policy/README.md, summary and desktop/mobile screenshots. 1573 backend tests (19 new), 170 UI tests, lint/build/architecture/Prisma and four zero-finding audits pass. Real local database rollback for settings and binding audit failures, concurrent approval once, stale/foreign/role/superseded refusal and exact replay tested. Parent retains 12 organization/intake, eight admission and seven browser groups. All fictional records/database removed. Fixture identity is not production authentication acceptance; existing toolchain/pg deprecation notices remain documented.

New controllers/services are unregistered in production. Fixed positive integer USD cents only; fail_closed and webhook validation mandatory; no exceptions, emergency surcharge, SDK/provider/payment/gate change, schema or migration. Missing preferred window and contact/address verification still block. No booking, charge, send, merge/deploy, real data, IAM/secrets/billing or charges. This is a local policy source/attachment workflow, not automatic adoption by every existing job-creation path.

Stop for review. Next proposed: return to explicit preferred-service-window review on the created job, with exact job version; a preference is not availability or booking. Existing-job repricing/current-policy rollout and production/integration acceptance remain gates. APP-013 sole Now, Next empty, FE-014 paused; sales/advisor/website import outside MVP. Progress unchanged: APP-013 50% scope coverage / 0 of 12 accepted, onboarding 50% local / 0 of 6 accepted, pilot 0 of 12 accepted. No overall engineering percentage or ETA.

## Local job booking-readiness preview (2026-09-10, prior checkpoint)

Owner reviewed the browser admission checkpoint and approved the proposed bounded S2 readiness section. Added inactive jobId-only POST /booking-readiness/preview and operator fixture control opening the newly created job. Verified non-impersonated owner/admin/dispatcher and active tenant; CREATED jobs only. PostgreSQL repeatable-read READ ONLY snapshot reuses intake assessment and payment gate without changing policy/integrations. Missing explicit payment flags are UNKNOWN, not no-payment-required; missing window, human/verification and unfinished Calendar blockers are visible. No blockers still requires booking validation, never grants authority.

Confirmation preview explicitly refuses APPOINTMENT_NOT_FINALIZED for this unbooked job; no date, link or message is fabricated. This is not finalized-event content rendering or positive recipient/consent eligibility. No production module registration, booking, payment, sending, provider actions, schema/package changes or release authority.

Evidence: backend evidence/APP-013/booking-readiness-preview/README.md, summary and desktop/mobile screenshots. 1554 backend tests including 12 new, 170 UI tests, lint/build/architecture/Prisma and four clean dependency audits pass. Local proof now covers 12 organization/intake, eight admission and six browser groups. Reads leave job/audit unchanged; fictional required-payment policy demonstrates refusal; all disposable records removed. Prior Calendar test instability remains historical; this run passed. Existing non-blocking toolchain warnings and one pg concurrency deprecation are recorded.

Stop for review. Next proposed outcome: authorized review of missing preferred window and applicable payment policy on the created job, followed by the local booking decision; inspect/reuse existing mutation contracts before implementation and do not treat diagnostic flags as policy authority. Full S2 booking/notification remains open. APP-013 sole Now, Next empty, FE-014 paused. Coverage unchanged: APP-013 50% / 0 of 12 accepted, onboarding 50% local / 0 of 6 accepted, pilot 0 of 12 accepted. No overall engineering ETA. No merge/deploy, production migration, real data, IAM/secrets/billing/charges; advisory sales/website import outside MVP.

## Browser customer submission and operator approval (2026-09-10, prior checkpoint)

Owner approved continuing the local admission connection. Customer fixture explicitly submits its reviewed draft; separate operator fixture loads an opaque reference, reviews facts/current organization version, selects urgency and acknowledges statements, then creates one CREATED job. Inactive customer transport adds submit; new guarded read/approve controller is deliberately absent from production modules. Customer credentials never enter operator requests. Exact retry after lost acknowledgment returns the original outcome; closed/expired/changed requests do not silently become replacements.

Evidence: backend evidence/APP-013/browser-review-admission/README.md, browser-review-summary.json and three screenshots. Five new real-browser/local-database groups plus 20 prior organization/admission groups pass. 1542 backend tests (four new), 170 UI tests, lint/build/architecture/Prisma and four zero-finding audits pass. One existing Calendar HTTP test failed during a concurrent run, then the isolated full suite passed; root cause is not established. Disposable fictional records/databases removed. No process-kill or production-auth acceptance claim.

The local approved-information → customer submission → operator review → one job connection is now demonstrated. CREATED is not booked, charged, dispatched or sent; contact/address remain unverified. Stop for owner review of this connected milestone, then select the next existing MVP outcome. Do not automatically extend hardening or promote a ticket. Post-expiry/status recovery, changed-approval recovery, production identity/shared budget/key/retention/access controls and old-reader rollout remain gates. No live AI/provider action, schema/package change, production registration, real data, merge/deploy, IAM/secrets/billing or charges.

Progress unchanged: onboarding 3/6 = 50% local evidence and 0/6 accepted; APP-013 50% recorded scope coverage and 0/12 accepted; pilot 0/12 accepted, not 0% built. No defensible overall engineering percentage or ETA. APP-013 stays sole Now, Next empty, FE-014 paused; sales/advisor and website import remain outside MVP.

## Token-free operator admission (2026-09-10, prior checkpoint)

Owner approved proceeding from organization-bound intake to one job. Added unregistered admitReview: exact requestId, expectedOrganizationApprovedAt and explicit human decision; verified non-impersonated owner/admin/dispatcher only. No customer credential is accepted, read or reconstructed. Locked durable draft/transcript/current organization checks precede shared atomic customer/address/job/link/consent/audit/session-close persistence. Job policy retains request and organization binding; request event remains unchanged. Exact same-actor/decision replay before original expiry and while job/approval remain valid returns the original receipt without writes. No booking or delivery authority.

Backend evidence: evidence/APP-013/operator-review-admission/README.md and operator-admission-summary.json. 1538 backend tests (18 new), 170 UI tests, lint/build/architecture/Prisma, four clean audits; eight new local database groups plus 12 prior organization/browser groups pass. Real rollback and concurrency tested; three fictional jobs and their fixture database removed. No new browser admission controls, production auth acceptance or process-kill test. Shared persistence refactor preserves legacy admitDraft behavior. No schema/package/migration/route/module/UI activation or provider action.

Next after review: connect customer submission and operator decision controls to this local protected admission flow, including honest pending/uncertain/stale states. Full browser organization-to-job walkthrough remains unfinished. Post-expiry/status recovery, approval-change UX, production identity/key/retention and old-reader rollout remain gates. Customer/address remain unverified; CREATED is not booked. APP-013 stays sole Now; Next empty; FE-014 paused. Sales/advisor and website import stay outside MVP. Progress unchanged: onboarding 50% local evidence/0% accepted; APP-013 50% scope coverage/0% accepted; pilot 0% accepted, not 0% built. No overall engineering ETA. No merge/deploy, production migration, real data, IAM/secrets/billing or charges.

## Approved organization to protected intake (2026-09-10, latest review-ready)

Owner said proceed after the documentation-only advisory vision clarification. Completed one local steel-thread connection: continueOrganization answers from this tenant's approved FAQ/fallback, persists encrypted version-2 turns bound to approval timestamp/digest, and existing customer submit/operator read preserves and checks that binding. Draft edits do not change answers; reapproval invalidates the old session/request. Scripted and organization histories cannot mix. Operator read uses no customer credential and identifies organizationApprovedAt. No customer production route, live AI, job admission or provider activation. Sales/advisor and website-import work remain outside MVP.

Evidence: backend evidence/APP-013/organization-intake/README.md, summary and desktop/mobile screenshots. 1520 backend tests (nine new), 170 UI tests, lint/build/architecture/Prisma, four clean audits; 12 local organization/database/browser groups including five new intake groups. Browser demonstrates approved reply through optional-email skip/read-only draft; durable submission and operator read are service-boundary proofs, not a finished browser-to-job workflow. Disposable database removed and cleanup query empty. No schema/package/migration change. Version-2 history needs separately reviewed old-reader rollout; changed-approval recovery remains a human-owned future UI task, not silently repaired here.

Percentages unchanged: onboarding 50% local outcome evidence (3/6), 0% accepted (0/6); APP-013 50% scope coverage, 0% accepted (0/12); pilot 0% accepted (0/12). No overall engineering percentage or ETA. Next after review: token-free operator admission from durable request with organization-version binding and atomic job/consent outcome, followed by browser decision integration. APP-013 sole Now, Next empty, FE-014 paused. No merge/deploy, production migration, live data/provider/IAM/secrets/billing or charges.

## Organization setup slice (2026-09-10, latest review-ready)

Completed the owner-approved S0 page/API slice within the explicitly amended APP-013 steel-thread dependency. Company facts, greeting/tone and sourced FAQs save to a tenant-scoped draft; exact saved-version approval preserves a separate approved snapshot; deterministic FAQ or human-contact fallback preview uses only that snapshot. Source routes are registered and the root sandbox links to /app/organization; nothing is deployed. No runtime AI, customer-journey/job connection, canonical policy changes or provider calls. Details and exact commands: backend evidence/APP-013/organization-setup/README.md; governance DATA_CONTRACTS.md.

Validation: 1511 backend tests (19 new), 170 UI tests, lint/build/architecture/Prisma and four clean dependency audits. Seven local database/browser proof groups cover concurrency, audit rollback, tenant/role refusal, draft/approval separation, desktop/mobile and stale-save recovery. Fixture identity is explicitly substituted, not production Firebase acceptance. Temporary databases removed; cleanup query empty. No migration/package changes. Profile facts do not configure scheduler timezone or replace payment/routing policies; manual consistency review is still required. Exact-match preview is not semantic AI or automatic human-task creation.

Progress: onboarding 3/6 = 50% locally demonstrated outcomes (O1/O3/O4), 0/6 = 0% formally accepted. APP-013 recorded scope coverage remains 50%, formal acceptance 0/12 = 0%; pilot acceptance 0/12 = 0%. These are distinct denominators, not an engineering ETA. Next after owner review: connect the approved organization snapshot to the protected customer intake/operator request-to-job path, preserving tenant/revision authority and no external actions. Full steel thread is not complete. APP-013 stays sole Now; Next empty; FE-014 paused. No merge/deploy, production migration, IAM/secrets/billing, real-data/provider or charge authority.

## Approved steel-thread implementation (2026-09-10, current)

Owner said “great proceed” after selecting the organization-to-job walkthrough. APP-013 explicitly owns the bounded S0 setup dependency for this walkthrough: owner/admin organization draft, version approval and deterministic FAQ/fallback preview with a usable page. This is an explicit scoped amendment, not APP-033 promotion. Reuse tenant settings and auth; no change to canonical booking/payment/routing policies. APP-013 stays sole Now; Next empty; FE-014 paused. Full customer-to-job integration follows review, not automatic completion. Live AI/provider calls and all release actions remain disabled. Acceptance percentages remain unchanged until evidence and owner acceptance.

## Organization setup and progress baseline (2026-09-10, latest planning)

Owner approved organization-onboarding gap review and requested percentages. See governance `ORGANIZATION_ONBOARDING_MVP.md`: basic tenant name/instructions and separate settings exist, but no organization onboarding page or approved FAQ/voice workflow was found in the inspected feature tree. Proposed next milestone S0 is owner-approved organization facts/rules/FAQ/brand voice with local answer preview, before S1 intake-to-job. Map implementation ownership and align governance before coding; APP-013 remains sole Now, Next unassigned, FE-014 paused. This is not automatic APP-033 promotion or an APP-013 scope expansion.

Progress baseline: APP-013 **50% recorded scope coverage** (1 demonstrated + 10 partial at half weight + 1 missing, divided by 12), **0/12 = 0% formal acceptance**; organization onboarding **0/6 = 0% acceptance**; full pilot **0/12 = 0% acceptance** against the existing pilot checklist. These are separate denominators, not effort, release readiness or an overall build percentage. Onboarding refines the existing business-controls requirement; do not add its six checks to the pilot denominator. No new engineering completion percentage or ETA is inferred. This documentation-only update does not rerun earlier runtime/security gates or claim new acceptance.

## MVP steel-thread audit (2026-09-10, current planning checkpoint)

See governance `CALLDESK_STEEL_THREAD_CLOSEOUT.md` for the fixed MVP outcome milestones and twelve-criterion APP-013 ledger. This planning checkpoint supersedes earlier automatic next-section suggestions and rolling section-count forecasts, not product scope or contracts. APP-013 remains sole Now, acceptance 0/12; Next unassigned and FE-014 paused. Next decision is approval of web chat as the first proving channel and a usable customer/operator intake-to-job demonstration target; phone/SMS remain required for MVP. No coding, ticket promotion or release action in this checkpoint.

Canonical governance source: `/Users/debynyhanbanks/Web Projects/signmons-governance`.
Global pointer: `/Users/debynyhanbanks/Web Projects/signmons-governance/GLOBAL_EXECUTION_POINTER.md`.

## Rules

1. Execute only the ticket listed in `Now`.
2. One focused commit per ticket.
3. No scope expansion.
4. Required backend gates must pass before moving to `Done`:
   - `npm run -s build`
   - `npm test -- --runInBand`
   - `npm run -s arch:check`
5. APP implementation requires an explicit global pointer in governance.

## Now

- [ ] APP-013 Twilio-backed notification center and transactional customer messaging (`SCR-APP-021`, `SCR-APP-022`, `SCR-TECH-005`)
  - Split customer/operator review-request foundation is review-ready: encrypted one-time customer submission and authorized request-ID-only operator read, no stored or reconstructed customer bearer. 1492 backend/170 UI tests, ten new PostgreSQL groups and prior browser/crash regressions pass; four audits clean. Original session deadline, stale/closed refusal and exact replay remain. No request-to-job admission or UI/route activation. Next proposed: token-free operator admission from the durable request with atomic job/consent outcome, no external actions. Coverage 50%, acceptance 0/12; 7-12 APP-013 / 20-35 pilot unequal sections, low confidence. APP-013 stays Now.

## Next

- Unassigned at program level. Finish APP-013 and explicitly update governance before selecting another ticket.

## Later

- APP-017 Business rules and automation center (`SCR-APP-026`)
- APP-018 Brand voice and AI personality configuration (`SCR-APP-027`)
- APP-019 Customer profiles and service history (`SCR-APP-028`)
- BE-001 Keyword opt-in/out persistence and telemetry (backend reliability stream)
- Remaining backend-aligned work from `/Users/debynyhanbanks/Web Projects/signmons-governance/MVP_BACKLOG.md`

## Done

- [x] BE-008 Twilio communications foundation
  - Backend PRs `#15` and `#16`; staging revision `signmons-calldesk-staging-app013bounds`; signed inbound voice/SMS, STOP/START consent, one consented outbound delivery and terminal callback, simulated rejection, dead-letter visibility, acknowledgment-gated replay, environment separation, and rollback controls accepted September 7, 2026. Evidence: `evidence/BE-008/readiness-report.md`.
- [x] APP-012 Payment gate and webhook status workflow (`SCR-APP-006A`, `SCR-APP-006B`, `SCR-APP-006C`, `SCR-APP-023`, `SCR-CUST-002`)
  - Backend PR `#14` merged at `068f4c2`; Cloud Build `dd7ca7ec-1777-45b6-8659-fba8998a9b63`; migration execution `signmons-calldesk-migrate-pgr84`; Cloud Run revision `signmons-calldesk-staging-app012release`; Firebase routes `/app/dispatch`, `/appointment/manage` and `/payment/status`; sandbox Stripe automatic delivery and duplicate retry passed. Live-mode Stripe remains separately approval-gated.
- [x] APP-011 Customer booking status and confirmation flow (`SCR-CUST-001`, `SCR-CUST-003`)
  - Backend PR `#13` merged at `28d394f`; migration `signmons-calldesk-migrate-xztrh`; Cloud Run revision `signmons-calldesk-staging-00024-wwn`; customer page `https://signmons-calldesk.web.app/appointment/manage`; evidence in `evidence/APP-011/readiness-report.md`.
- [x] APP-010 Routing rules, service areas, and availability (`SCR-APP-015`, `SCR-APP-016`, `SCR-APP-024`, `SCR-TECH-004`)
  - Backend PR `#11` merged at `b809b9d`; Cloud Run revision `signmons-calldesk-staging-00023-47g`; Firebase console `https://signmons-calldesk.web.app/app/routing`; isolated staging acceptance completed September 2, 2026.
- [x] APP-009 Technician mobile job workflow (`SCR-TECH-001`, `SCR-TECH-002`, `SCR-TECH-003`)
  - Owner phone acceptance completed September 2, 2026; evidence in `evidence/APP-009/readiness-report.md`.
- [x] APP-008 Dispatch board and technician assignment (`SCR-APP-014`, `SCR-APP-017`)
  - Backend merge `d8de259`; Cloud Run revision `signmons-calldesk-staging-00020-m2m`; console `https://signmons-calldesk.web.app/app/dispatch`; evidence in `evidence/APP-008/readiness-report.md`.
- [x] APP-007 Urgency classification and escalation review (`SCR-APP-013`)
  - Evidence: `evidence/APP-007/readiness-report.md`; released on Cloud Run revision `signmons-calldesk-staging-00019-swf`.
- [x] APP-006 Intake review and booking readiness (`SCR-APP-012`)
  - Evidence: `evidence/APP-006/readiness-report.md`
- [x] APP-003 Job completion lifecycle foundation (`SCR-APP-005`)
  - Evidence: `evidence/APP-003/readiness-report.md`
- [x] BE-007 Tenant lead-source reporting pilot
  - Evidence: `evidence/BE-007/readiness-report.md`
- [x] BE-003 Eternity webchat backend production readiness
  - Evidence: `evidence/BE-003/readiness-report.md`
- [x] R6-P0-1 SMS Twilio signature guard parity
- [x] R6-P0-2 Stripe local-bypass env validation parity
- [x] R6-P0-3 Exception diagnostic redaction policy
- [x] R6-P0-4 Payments presentation boundary extraction
- [x] R6-P0-5 Legacy voice controller suite replacement
- [x] R6-1 Forced-hangup scheduler extraction
- [x] R6-2 Voice turn orchestration decomposition
- [x] R6-3 Tenant-isolation assertions at inbound boundaries
- [x] R6-4 Latency and open-handle stabilization
- [x] R6-5 Architecture governance lock-in
- [x] REFACTOR5 completed (see `refactor5.md`)
- [x] BE-002 Marketing lead-capture API persistence contract (supports `FE-007`)
