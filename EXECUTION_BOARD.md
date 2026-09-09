# Signmons Backend Execution Board

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
  - Guarded CREATE composition is review-ready on PR #21: shared signed request admission feeds canonical journal claim and one-shot read-back execution in an inactive internal service. Unknown reservation outcomes never execute/fall back; existing unfinished requests remain held. 742 backend tests, real composed success/uncertainty/payment/concurrent proof, 15 migrations/11 prior crashes, five browser suites and four clean audits pass. Public receipts, recovery/office-review ownership, customer handoff and acceptance remain open; no activation/deployment.

## Next

- [ ] APP-017 Business rules and automation center (`SCR-APP-026`)
- [ ] APP-018 Brand voice and AI personality configuration (`SCR-APP-027`)
- [ ] APP-019 Customer profiles and service history (`SCR-APP-028`)
- [ ] BE-001 Keyword opt-in/out persistence and telemetry (backend reliability stream)

## Later

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
