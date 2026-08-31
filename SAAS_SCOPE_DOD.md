# Backend Scope + DoD Alignment (High-Ticket)

Purpose: ensure backend execution stays aligned with the high-ticket frontend/governance plan.

## Authoritative Scope

Canonical source of truth is:

- `/Users/debynyhanbanks/Web Projects/signmons-governance/SAAS_SCOPE_DOD.md`

This local file defines backend-specific alignment checks and readiness gating.

## Backend Alignment Checklist

- [x] APP-003 was explicitly allowed by governance and completed as an owner-approved Eternity pilot operations exception.
- [x] Marketing-first work has resumed at FE-013; the backend queue is blocked until another explicit unlock.
- [ ] Public routes with backend dependencies match governance:
  - `/demo` -> `POST /api/marketing/try-demo`, `GET /api/marketing/try-demo/:leadId`, `POST /api/marketing/try-demo/status`
  - `/contact` -> `POST /api/marketing/lead-capture`
- [ ] Route/API ownership is updated in governance `SCREEN_ROUTE_API_MATRIX.md` when backend behavior changes.
- [ ] CTA conversion behavior remains aligned with governance `LINK_CTA_MAP.md`.
- [ ] Tenant isolation, policy gates, and auditability requirements remain enforced.

## Backend Ticket DoD

- Ticket appears in backend `EXECUTION_BOARD.md` `Now` and is unlocked by governance pointer.
- One focused commit.
- Required gates pass:
  - `npm run -s build`
  - `npm test -- --runInBand`
  - `npm run -s arch:check`
- Evidence attached to PR/notes.
- `SESSION_HANDOFF.md` updated.

## Readiness Gate

`No additional APP implementation starts until the marketing pointer unlocks it.`
