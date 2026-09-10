# Signmons Backend Execution Board

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
