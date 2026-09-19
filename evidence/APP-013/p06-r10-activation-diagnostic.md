# P06 / R10 read-only activation diagnostic

## Section card — 2026-09-19

- Approved section: APP-013/P06/R10, whose observable acceptance requires the exact enabled revision and runtime approval to pass readback before the one capped connected journey. R10 remains open.
- Source: backend `4a23c7b`; governance `247b999`; stopped plan `a6cde0d0-ae91-4309-a200-023937ea8408`; packet `48596642-a7ef-404d-a720-7fbbca3a51b5`.
- Demonstrated gap: the one approved activation was reserved inside its window and stopped at controller stage `ACTIVATE`. The deliberately sanitized operator boundary returned no activation result or internal guard, so repeating packet preparation cannot establish which existing prerequisite refused.
- Connected-workflow effect: identifying the failed activation prerequisite is necessary before another zero-traffic deployment and the R11 verification/address/reviewed-submit journey can be responsibly attempted.
- Reused interfaces: `scripts/p06-runtime-packet.mjs::reviewPacket`; `scripts/p06-migrate-once.mjs::manifest`; the production organization-profile and payment-policy parsers; fixed P06 target metadata. No application route, startup registration, provider adapter or customer interface is added.
- Behavior/files: `scripts/p06-r10-activation-diagnostic.mjs` classifies the exact packet, attempted operation/time, database identity, migration history, tenant/status/inactive approvals, unused operation ID, service category and approved organization/payment bindings. Its optional fixed-target adapter uses `neondb_owner` only through a hidden-input wrapper and one repeatable-read `READ ONLY` transaction. It returns only `status`, `outcome` and a bounded stage; it returns no tenant settings, participant data, phone, HMAC, secret, password or database exception. Direct CLI use is inert.
- Boundaries: the diagnostic reads only the fixed child database. It has no SQL mutation, role/IAM/secret control, Cloud Run/Twilio access, deployment path, activation call, provider request, verification-code path, address call, submission or job path. The expired packet is evidence input only and cannot be retried.
- Checklist: pure stage classifier complete; fixed-target read-only adapter complete; success/failure sanitization tests complete; inert CLI test complete; focused existing packet/controller regression complete. A live database read remains separately approval-gated.
- Tests: positive matching snapshot; failures for identity, migration, tenant state, prior approvals, consumed operation, historical window, category and both approved-policy bindings; direct CLI no-action; existing runtime-packet/controller suites. A separately authorized live read will provide the diagnostic result. No browser test applies because this work neither opens nor changes a browser surface.
- Dependencies/owners: owner approval and attended hidden password entry are required for one live database diagnostic. Codex may then interpret the bounded result and repair only the demonstrated local cause. Any new packet, LOGIN change, activation, deployment, provider action or customer journey remains separately gated.
- Recovery/rollback: no external state exists to roll back. Removing the two diagnostic script files reverts the local addition. A live diagnostic closes its connection in `finally` and cannot change database state because both connection default and transaction are read-only.
- Finish/evidence: local finish is the passing checks below plus committed source. R10 remains incomplete until later live activation and deployment readbacks meet the existing criterion.

## Local result

The diagnostic is implemented and locally verified. It does not assert the cause yet because no live database read was performed.

Validation:

- `node --test scripts/p06-runtime-packet.test.mjs scripts/p06-r10-activation-diagnostic.test.mjs scripts/p06-r10-controller.test.mjs` — 32 passed.
- `npx prettier --check scripts/p06-r10-activation-diagnostic.mjs scripts/p06-r10-activation-diagnostic.test.mjs` — passed after formatting.
- `npm run arch:check` — passed.
- `SIGNMONS_GOVERNANCE_REPO=/Users/debynyhanbanks/Web\ Projects/signmons-governance-r08-recovery node scripts/check-governance-baseline.mjs` — passed.
- `git diff --check` — passed.

No database connection, LOGIN change, activation, deployment, Cloud/Twilio request, verification code, address request, browser journey, submission, job or customer contact occurred. P06 remains 11/14 with R10/R11/R12 open. Original dirty APP-010 checkout preserved. No scope deviation.
