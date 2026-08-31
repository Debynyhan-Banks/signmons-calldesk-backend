# Backend Session Handoff

Last Updated: 2026-08-30

## Active owner-approved pilot

- Canonical `Now`: `BE-007` tenant lead-source reporting pilot.
- Contract: authenticated `GET /reports/lead-sources`, verified tenant context, owner/admin/manager access, explicit UTC date bounds up to 366 days, PII-free aggregate output and no-store caching.
- Implementation is isolated under `src/reporting/`; focused tests cover calculations, accepted-lineage cancellation handling, unauthorized roles, bounded ranges and a PII-free Prisma select.
- Required backend gates currently pass: build, 80 tests and architecture check. Repository-wide lint still contains two pre-existing test-file findings outside BE-007 and is not a backend completion gate.
- Next: push the focused backend commit, deploy one Cloud Run revision, verify the live endpoint rejects unauthenticated access, and produce production-safe aggregate evidence.

## Current Program Pointer

- Active backend exception: `BE-007` tenant lead-source reporting pilot
- Next global pointer: `FE-013` after BE-007 completion
- Backend state: Eternity pilot is live; reporting release is implemented locally and awaiting verified deployment

## Completed In This Session

- Repaired reproducible install/build and Prisma generation.
- Added canonical schema reconciliation that preserves the legacy schema and verified it on PostgreSQL 16 with seeded records.
- Added tenant-bound server-to-server webchat authentication and deterministic life-safety interception.
- Removed unapproved pricing, default promotion, and human-impersonation language from default prompts.
- Restored lint, build, unit, database integration, architecture, and critical-audit gates.
- Recorded exact evidence and remaining deployment prerequisites in `evidence/BE-003/readiness-report.md`.

## Next Actions (Strict Order)

1. Synchronize BE-003 completion in governance and return the global pointer to FE-013.
2. Do not connect the live Eternity website until deployment credentials, managed database, tenant configuration, human escalation ownership, and privacy disclosure are approved.
3. Re-run dependency audit and all gates before deployment.

## Restart Commands

```bash
git status --short
npm run -s build
npm test -- --runInBand
npm run -s arch:check
```
