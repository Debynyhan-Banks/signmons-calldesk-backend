# APP-010 Continuation Validation Evidence

Date: 2026-09-02
Branch: `codex/app-010-routing`
Scope: missing/cross-tenant update boundary and required-name validation only

## Automated Validation

| Gate | Result |
| --- | --- |
| `npm run -s build` | Passed |
| `npm run -s lint` | Passed |
| `npm test -- --runInBand` | Passed: 24 suites, 162 tests |
| `npm run -s arch:check` | Passed |
| `npx prisma validate` | Passed |
| `cd ui && npm run -s build` | Passed: 11 static routes, including `/app/routing` and `/app/dispatch` |
| `cd ui && npm run -s lint` | Passed: no warnings or errors |
| `cd ui && npm test -- --runInBand` | Passed: 4 suites, 14 tests |
| `node scripts/docs-consistency-check.mjs` in governance | Passed |
| `npm audit --omit=dev --audit-level=critical` | Passed threshold: 0 critical; 4 high and 8 moderate advisories remain |

## Focused Regression Evidence

- Missing or cross-tenant routing-rule updates return the same bounded `NotFoundException` and create no audit record.
- Missing or cross-tenant service-area updates return the same bounded `NotFoundException` and create no audit record.
- Whitespace-only routing-rule and service-area names fail DTO validation after normalization.
- Focused routing suite passed 6 of 6 tests.

## Responsive Browser Evidence

- Desktop `/app/routing`: rendered at 1440 x 900 with no horizontal overflow; operator token remained a password input and unauthenticated write controls were disabled.
- Phone `/app/routing`: rendered at 390 x 844 with a 390-pixel document width, 68-pixel compact navigation, both forms present and unauthenticated writes disabled.
- Phone `/app/dispatch`: rendered at 390 x 844 with no horizontal overflow, exposed the routing navigation link, displayed the safe connect state and produced no application-origin console errors or warnings.

## Scope Boundary

No merge, migration, deployment, IAM, secret, billing, external message or real-customer action was performed.
