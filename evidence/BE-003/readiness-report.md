# BE-003 readiness report

Date: 2026-08-28

## Outcome

The backend is contract-ready for a staged Eternity Mechanical Services webchat deployment. This ticket does not deploy the backend or connect the public website.

## Verified evidence

- Final `npm ci` generates and links Prisma Client without a real database credential.
- PostgreSQL 16 accepted all three migrations on a fresh database.
- The reconciliation migration moved the original `Tenant`, `Job`, and `CallLog` tables into `legacy_2025` and created all 20 canonical public tables.
- A separate seeded preservation run retained one legacy tenant, job, and call log after reconciliation.
- All 38 unit and database integration tests passed with open-handle detection enabled.
- The compiled server returned healthy liveness/readiness responses, deterministic carbon-monoxide guidance, and HTTP 401 for an invalid webchat credential.
- The compiled system-prompt asset was present in `dist/ai/prompts`.
- Lint, build, and architecture gates passed.
- `npm audit --omit=dev` reported zero critical advisories.

## Accepted dependency advisory risk

The production audit still reports three high advisories through Prisma 7.10's configuration stack (`prisma` -> `@prisma/config` -> `deepmerge-ts`) and eight moderate transitive advisories through Firebase Admin 13.10 and Google client libraries.

This is accepted for the staged backend-readiness branch because:

- the acceptance criterion is zero critical advisories, which passes;
- the Prisma high-severity path is build/migration tooling and receives no customer-controlled recursive configuration objects at runtime;
- the application imports Firebase App/Auth only, not Firestore or Cloud Storage, and does not invoke the affected UUID buffer APIs;
- forcing the audit's suggested Prisma downgrade or Firebase Admin downgrade would be a major compatibility regression and did not remove the disclosed transitive paths safely.

Recheck these advisories before production deployment and update when compatible upstream releases resolve them.

## Deployment prerequisites

- Managed PostgreSQL URL with migrations applied.
- A 24+ character admin token.
- Firebase project credentials and development authentication disabled.
- OpenAI API key and approved model identifier.
- Eternity tenant record with approved instructions and human escalation owner.
- Random server-held webchat credential; configure only its SHA-256 hash in `WEBCHAT_INTEGRATIONS_JSON`.
- Website-owned server proxy. The browser must never receive the credential.
- Eternity privacy disclosure updated before customer messages are processed.
