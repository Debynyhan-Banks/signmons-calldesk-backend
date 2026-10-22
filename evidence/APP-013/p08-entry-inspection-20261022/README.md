# APP-013 / 3A / P08 entry inspection — October 22, 2026

Status: **read-only local source/receipt inspection complete; new operator-access/local preparation proposal awaiting owner decision**. No P08 implementation, live account/database/permission lookup, user/token operation, provider action, payment or application change occurred. Owner “proceed” authorized preparation after P07; the additional demonstrated access prerequisite is proposed before implementation.

Backend source `1f22f47c18852b9039284fb163aacf4f789393da`; governance source `14d10f5c3458d4eb2c58e18ad131c7e999a6f3a3`; both focused branches `codex/p06-r08-recovery-20260918`, clean on entry. Origins remain the Signmons backend/governance repositories. Eighteen inspected-file hashes are in `source-sha256.json`. Source image remains the repaired P07 digest; no rebuild/deploy.

## Traceability and reuse

The unchanged finish is the existing 3A same-admitted-job authentic Sandbox payment, gate and recovery criterion. Current P07 result receipts/owner corroboration prove a healthy zero-normal-traffic repaired candidate, disabled exact destination/zero deliveries and closed role/zero sessions. They do not prove protected operator requests, policy binding, Checkout, signed settlement or payment acceptance. Retirement remains October 23, 6:15 p.m. Eastern; local preparation does not extend it.

| Inspected source / evidence | Finding and boundary |
| --- | --- |
| `src/jobs/jobs.module.ts`, `job-payment-policy.controller.ts`, `job-payment-policy.service.ts` | Binder is registered and owner/admin authenticated. Current approved policy identity, controlled-v2 digest, exact job version and no existing activity are mandatory. It preserves deterministic admission and does not assert human review. Reuse without a direct business-state SQL edit. |
| `src/payments/payments.module.ts`, payment controller/service | Registered create, tracking, event visibility and recovery routes use real authentication/tenant/role guards. Request amount is derived from trusted snapshots; stable key and existing active recovery seams exist. |
| `src/payments/stripe-checkout.provider.ts` | Direct connected-account Checkout, stable idempotency, bounded network timeouts; return page is informational; no new fee/routing/SDK or hard-coded method change needed. |
| Webhook controller/service and shared payment gate | Raw-body signature/mode/account/resource/money checks and current locked-payment transition/audit transaction already exist. Audit projection contains event type, internal payment ID and event time rather than a raw provider payload. Reuse existing duplicate/race/terminal-state evidence, then separately qualify authentic provider observations. |
| `ui/src/app/app/dispatch/page.tsx`, `ui/src/lib/api.ts` | Existing create/recovery/status controls and session-scoped request key can be reused. Default or old staging-pinned output is not a qualified exact-target proof. Tenant-wide list/adjacent dispatch actions are outside the proposed exact-job supervisor. |
| `scripts/fixtures/payment-policy.js` | Existing explicit policy acknowledgment/control is internal fixture code, not a published commercial operator UI. No fixture result establishes live policy or payment. |
| P07 private controller/firebase helper and copied result receipts | Old Firebase phone-test identity remains disabled; candidate has seven secret-level bindings and zero project roles. Health uses no authenticated operator route. Effective inherited Firebase access has not been checked and is unknown. |

## Two source-demonstrated operator prerequisites

`RequestAuthGuard` chooses Firebase `sub` as the request user, verifies the bearer with revocation checking enabled and forbids dev headers in production. `FirebaseAdminService` uses the revision's Application Default Credentials. Installed Firebase Admin `base-auth.js` calls `getUser(decodedIdToken.sub)` for disabled/revoked validation. Public Firebase documentation confirms the additional lookup, and Identity Platform maps it to `firebaseauth.users.get`. P07's secret-only access plan does not establish that permission. This is an unqualified dependency, not a claim that a live request has returned a permission denial.

The previous fixed phone-test UID is not UUID-shaped (checked locally without contacting Firebase). Payment request/recovery audit paths set `actorUserId` to the authenticated actor. `prisma/schema.prisma` defines that field as UUID with a composite same-tenant User relation; User.id is UUID. The real local P07 proof seeds a UUID-backed owner before exercising payment. Therefore the old fixture identity cannot simply be activated and presumed suitable. A live existing eligible application user, matching isolated Firebase UID and claims are unqualified. No real Checkout was created to reproduce this risk; no application schema/auth behavior was changed.

Sources: [Firebase Admin verification reference](https://firebase.google.com/docs/reference/admin/node/firebase-admin.auth.baseauth), [Identity Platform API permissions](https://docs.cloud.google.com/identity-platform/docs/access-control). These were public documentation reads, not authenticated project qualification.

## Decision, bounded tasks and exclusions

The reviewable pre-code card/change request is governance `APP013_P08_OPERATOR_ACCESS_PREPARATION_PROPOSAL_20261022.md`. Recommended Alternative 1 is local-only: a disabled exact-job supervisor and read-only qualification mode; real disposable PostgreSQL actor/audit/output tests; mocked Firebase/Stripe, real existing guards/services; loopback browser with external-request blocking; deadlines/signals/exclusive attempts, credential privacy and truthful containment. It prospectively enumerates the minimal Firebase lookup/signing permissions and isolated UUID-backed test identity path without creating any of them. Runtime read access is project-wide user-read capability, not per-UID IAM; signing capability is not per-UID cryptographic enforcement. These limits must remain visible in any exact operation proposal.

Completed: canonical/source/runtime-evidence reconciliation, route/data/identity mapping, 18 source hashes, explicit gap/alternatives/card. Remaining: owner decision before implementing this access plan; local packet/proof if approved; separately approved read-only qualification to bind actual actor/amount/access; finished external payment proposal; authentic same-job result and mandatory cleanup; owner 3A acceptance. Implementer owns preparation/evidence; Debynyhan Banks owns these approvals/attendance/acceptance. No blanket permission from prior P07 or its consumed window.

No code/schema/grant/secret/token/user/provider change, new job, policy rewrite, test event/payment, UI publication, customer contact, booking, merge or push. No substitute offline product work. Application unit/database/browser tests were **not run** for this inspection; their earlier results are historical reuse evidence, not new. Documentation baseline/consistency/safeguard/architecture/whitespace checks are recorded after this update. No test/helper count changes product progress: **0/27 newly closed R1; 6/60 legacy; 4/8 walkthrough; 0/13 intelligence**.

**Explicit deviation proposal before implementation: the narrow P08 operator/permission prerequisite. No implemented scope deviation.**

## Documentation verification

Passed at this inspection checkpoint: frozen-baseline check, cross-repository documentation consistency from both checkouts, all 25 governance safeguard tests, backend architecture and both whitespace checks. All 18 inspected-source hashes still match. No application unit, database or browser test was run, and no historical runtime test result is claimed as new.
