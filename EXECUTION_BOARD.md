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

## Now

- [ ] APP-006 Intake review and booking readiness (`SCR-APP-012`)
  - Owner: backend app
  - Ticket spec: `/Users/debynyhanbanks/Web Projects/signmons-governance/TICKETS/APP-006.md`

## Next

- [ ] APP-007 Urgency classification and escalation review (`SCR-APP-013`)
- [ ] APP-008 Dispatch board and technician assignment (`SCR-APP-014`, `SCR-APP-017`)
- [ ] BE-001 Keyword opt-in/out persistence and telemetry

## Later

- Remaining backend-aligned work from `/Users/debynyhanbanks/Web Projects/signmons-governance/MVP_BACKLOG.md`

## Done

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
