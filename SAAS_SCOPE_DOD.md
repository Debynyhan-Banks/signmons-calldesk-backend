# Backend Scope + DoD Alignment (High-Ticket)

Purpose: ensure backend execution stays aligned with the high-ticket frontend/governance plan.

## Authoritative Scope

Canonical source of truth is:

- `/Users/debynyhanbanks/Web Projects/signmons-governance/SAAS_SCOPE_DOD.md`

This local file defines backend-specific alignment checks and readiness gating.

## Backend Alignment Checklist

- [x] Current backend work item is explicitly allowed by governance `EXECUTION_BOARD.md` and global pointer (`APP-003` owner-approved Eternity pilot operations exception).
- [x] APP-003 is explicitly unlocked as a narrow exception; marketing-first work resumes at FE-013 after completion.
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

`No APP implementation starts until marketing pointer unlock, except the explicitly authorized APP-003 Eternity pilot operation.`
