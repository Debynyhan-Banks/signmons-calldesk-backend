# VO-1 durable address operations and liability — review checkpoint

Owner approved VO-1 after the sizing plan. Baselines: backend 13baff1, governance 1584bbe; both origin feature branches fetched/aligned, focused worktrees initially clean, original saved dirty checkout preserved. APP-013 only; no Eternity website work.

## Implemented boundary

AddressOperationLedger is an unregistered, disabled-by-default service with no provider dependency, HTTP client, route, worker or module registration. It accepts only action (reserve/claim/cancel), logical request UUID and session credential. The authenticated webchat integration context must match the verified session. Existing session locks check active tenant/customer/conversation. A trusted injected readBinding, under that lock, supplies a current immutable intent UUID, address revision and explicitly approved FIXTURE_ONLY policy. Production intent/policy storage and binding are not implemented; a browser cannot supply these claims. Changed input must receive a new server-owned intent reference/revision. No customer-input digest is needed or retained by this ledger.

Minimal migration 20260911120000_add_address_operation_liability adds operation and request-alias tables, a unique binding index, bounded state/cost checks and restrictive alias relation. It was applied only in the disposable local fixture. Policy SHA256 covers explicit policy/rate versions, validity, worst-case cost and account/tenant/session caps; it contains no customer input. The database stores Signmons UUID references, policy hash, revision, state, integer liability, creation time and attempt UUID. Audit entries record operation ID and transition only; no address/unit, phone/code, bearer, Google/provider content or raw errors.

Lock order is account, tenant, existing session/conversation, operation work. Cost and request allowances at all three levels are reserved in the same transaction as the operation and privacy-safe audit. Identical concurrent intent/policy submissions map to one operation, including different request UUIDs; aliases are capped at 20 per operation. Conflicting logical-ID reuse refuses. New operations refuse missing/stale/unapproved/malformed policy and exhausted money/request limits. Policy validity is checked again before transaction completion.

A claim transitions RESERVED to DISPATCH_CLAIMED once with a server-generated attempt UUID. Replay/restart reports claimed=false, never another claim. Even the winner reports dispatchAuthorized=false: this section cannot invoke a provider. Claim persistence or audit failure rolls back atomically. Safe cancellation releases held money only while RESERVED, atomically prevents a later claim, and does not refund request allowance. Claimed cancellation refuses. OBSERVED/UNCERTAIN are reserved schema states for VO-2, with no transition or recovery implementation here.

All holds and request counts remain across months, including cancelled request counts. There is intentionally no replenishment, settlement, automatic orphan reclaim, delete job or monthly reset. This conservative accounting can eventually refuse new requests and is not a production billing system. Policy/account authority consistency, operational deadlines, live account/rates/budget, accounting retention, freshness and current-proof consumption remain gates. No production data migration or release permission is implied by the new SQL file.

## Validation

- Six new unit cases: default disabled, malformed/expanded requests and missing trusted context refuse before persistence.
- Full backend 95 passing suites / 1,824 passing tests, three existing skips. Build, lint, architecture, Prisma schema validation, focused formatting and diff checks pass.
- Thirteen real PostgreSQL proof groups in scripts/verify-address-operation-ledger.mjs: aliases reserve once, concurrent claims once, restart refusal, foreign/edited scope refusal, competing tenants sharing a ceiling, prior-month holds, invalid policy, reserve/claim audit rollback, safe cancellation, all six money/request limits, claim-cancel race, closed session, privacy-safe columns.
- Parent scripts/verify-organization-profile.mjs passes its existing organization/customer/operator/phone/address/browser regression. No rendered UI changed and no new browser flow is claimed. Existing regression uses fictional data, including its own fictional jobs; VO-1 makes no job/provider call. Final summary: /private/tmp/signmons-vo1-final-20260911/address-operation-ledger-summary.json. Disposable fixture cleanup completed. Existing pg concurrent-query deprecation remains; dependencies unchanged, no fresh vulnerability audit claim.
- Prisma formatting initially touched unrelated whitespace; those mechanical changes were removed. Final schema diff contains only the two new models.

## Exact review and reproduction

Review address-operation-ledger.ts and its spec, both new Prisma models/migration, verify-address-operation-ledger.mjs and the parent hook. Confirm no additions to CommunicationsModule, production routes, Google/Twilio adapters or phone accounting. Review governance DATA_CONTRACTS.md and VO-1 checkpoint before running any migration outside this fixture.

```sh
npm run build
npm run lint
npm run arch:check
npx prisma validate
npm test -- --runInBand
ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-vo1-review PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs
```

The parent requires local PostgreSQL Unix socket and loopback/browser permission, creates a random calldesk_org_* database, applies repository migrations there, and removes it in finally. Do not run a production migration command.

Stop review-ready. Next proposed section is VO-2 bounded mocked execution/uncertain recovery connected to the existing customer journey, after owner review and explicit operational policy agreement. VO-3 freshness/revocation/cleanup and real-proof-to-job remain later. APP-013 scope index 50%, accepted 0/12; onboarding local 50%, accepted 0/6; pilot accepted 0/12. No whole-MVP percentage/ETA, merge, deployment, real data, live call or spend.
