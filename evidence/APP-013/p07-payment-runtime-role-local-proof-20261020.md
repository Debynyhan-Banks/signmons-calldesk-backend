# APP-013 / 3A / P07 — real local payment-role proof, October 20

Status: **local investigation completed; payment readiness BLOCKED**. The owner explicitly approved the finite disposable local role/database proof, real application/database services, mocked Stripe and verified cleanup. No application source, live grants/credentials, live database, secret/provider configuration, deployment, payment or customer journey was changed by this database proof.

## What was actually exercised

Source entry: backend f5931e214a1f40dee63c311bad1837e51255f29f; governance 1010571d84eb66e9d2b6eee256380fd225b558cd. Current application source remains the reviewed cec8216 release candidate, not a newly repaired image.

The proof creates a new PG18 cluster beneath a private /private/tmp/signmons-runtime-role-* directory, with TCP disabled and an exact Unix-socket/database identity check. It applies current migrations only to its new calldesk_org_<random> database; clears environment PG*/DATABASE_URL inputs; uses synthetic actors/jobs and a real direct p07_payment_runtime login. Only Checkout transport is mocked. It retains no query parameters or provider payloads. Generated INSERT column shapes and a role ACL hash are recorded below. These ACLs are neither row isolation nor a proven minimum for every application endpoint.

The first sandboxed launch stopped at local cluster setup and removed its scratch; the authorized isolated launch then exposed the immediate-retry limitation. The full run retained that failed probe, completed the remaining cases and exposed the distinct-event race. After tightening cleanup for uncertain startup acknowledgement, the final full run reproduced both observations and verified normal and SIGINT cleanup. Local reruns were diagnostic, with no provider/secret access or paid operation. No application assertion was changed to turn the race green.

**18 passed reported checks**, including 49 actual SQLSTATE 42501 permission refusals plus the original P06 proof's 13 permission refusals. Reported checks include the aggregate and its count subcheck; this is not a product acceptance count. Two failed probes remain explicit in the final nonzero result. Evidence covers:

- Direct restricted current_user=session_user identity; zero elevation, memberships or object ownership; no schema CREATE or database TEMP through PUBLIC.
- Controlled-v2 policy binding, concurrent exact replay, one binding audit, preserved non-human actor and real audit rollback.
- Payment reservation and post-provider reference persistence; stable same-key replay and active recovery; one winner for concurrent different keys.
- Five-minute abandoned-reservation recovery with the same mocked idempotency operation; account/policy/pricing/version/closed-state/foreign-job refusals before provider access.
- Populated current dispatch/routing/candidate reads plus payment/event tracking, rather than an empty-table or replacement-screen shortcut.
- Signed-format local settlement; one transition for concurrent identical events; wrong signature/mode/account/resource/metadata/money refusal without persisted changes; webhook audit rollback; sequential late failure/expiry and redirect-only state stay truthful.
- Excluded lifecycle, assignment, calendar, tenant configuration, user, subscription, ledger, communications and immutable identity writes denied by the actual role.

## Finding 1 — concurrent distinct events can regress a settled payment

**Acceptance-path defect and launch blocker.** Two real database reads both observe PENDING. The test scheduler pauses only delivery of those real query results; it never supplies mocked database rows. The successful Checkout event then commits SUCCEEDED. A previously read payment-intent failure resumes afterward and writes FAILED from stale state. The assertion expects SUCCEEDED and observes FAILED. Both events use the exact stored resources, valid local signature, same account/money/job/request and independent event IDs.

Source: StripeWebhooksService finds Payment and calculates transition before its transaction, then updates by payment identity without rechecking/locking the latest state. Identical-event uniqueness and sequential late-event tests do not prevent this interleaving. A role grant or health check cannot repair it. The old unused image contains this source and must not be treated as ready for payment.

Proposed next scope is a focused, separately approved local webhook serialization/revalidation repair. See governance APP013_P07_WEBHOOK_ATOMICITY_REPAIR_PROPOSAL_20261020.md. No application fix was implemented under the role-proof approval.

## Finding 2 — immediate retry after audit rollback is held for five minutes

**Observed recovery limitation; not automatically a new feature mandate.** A synthetic database trigger rejects payment.request_created after the mocked Checkout returns. The transaction rolls back Checkout references and audit, but the separately created Payment reservation remains PENDING. Immediate same-key create returns Conflict409 under the existing five-minute reservation guard. After a fixture-only time advance beyond that existing timeout, the same key recovers the same mocked Checkout and persists it; no second logical Checkout is created.

The initial adversarial probe assumed immediate recovery. The current implementation explicitly has a five-minute reservation timeout and does not promise immediate recovery for a failed database audit. Ordinary lost-response recovery with persisted Checkout references passes. Keep this observation visible; do not label it a second proven payment-integrity defect or silently remove its original failed result. The next proposal recommends retaining the existing hold and explicitly clarifying this probe's expected outcome, rather than expanding the application repair.

## Cleanup and preserved boundaries

Normal and actual SIGINT-after-role-activation runs verified NOLOGIN, limit0, past expiry, zero exact role/database sessions, role absence, database absence, stopped owned cluster and removed scratch. Cleanup now probes the owned data directory even if startup acknowledgement failed; that edge is source-reviewed, while the interruption test specifically covers SIGINT after role activation. A final read-only process inventory found no matching private-cluster PostgreSQL process. No pre-existing cluster/service/data was stopped or removed.

Original P06 fixture/helper hashes remain unchanged; its role was created only inside the new local cluster for its existing permission proof, then removed. The real P06 environment was not read or changed. The role boundary is source-derived and locally exercised, not a live ACL readback or provisioning approval.

## Other current validation and the browser scope exception

Backend build, lint, architecture and five relevant full Jest suites pass (83/83 tests). The nonexistent standalone job-payment-policy Jest filename in the draft card was corrected before implementation to the existing organization-policy suite; actual JobPaymentPolicyService behavior is covered by this real-role proof. No earlier full 2,611-test run is claimed as new.

The initial existing browser regression was stopped after its generated UI artifact proved staging-pinned while the fixture intercepted only localhost. It may have attempted a staging dispatch-board request with a synthetic token. No real credentials, customer inputs or payment inputs were supplied. Actual external effects remain unverified; no absence-of-effects claim or retrospective authorization is made. This unintended artifact drift was disclosed immediately. The owner explicitly approved a scratch localhost rebuild with external-request blocking before another browser run.

That isolated rerun passed desktop and mobile, each with stable retry, active recovery, no overflow, no UI errors and zero external page requests. Existing behavior assertions stayed intact; only the scratch fixture gained a pre-navigation non-loopback abort/count assertion. Original repository UI source/output, fixture and staging-preview archive hashes were preserved. This is synthetic UI proof, not a browser connected to the restricted database or a live payment acceptance.

| Tested artifact | SHA-256 |
| --- | --- |
| Grant fixture | `35785d3857f6fc9b01042d6dee3137eebb18950601fb1b8e7644e340be8fb83c` |
| Real-role proof | `36d6f2af684c3868c1aa972b98db6c73c3765270d35a533851bfe31730fb11c3` |
| Private final output | `5fb4cdf262b7b21c4826ec8267ceb02d90d836b24e4ff23a4e40c5d94f6650a4` |
| Preserved originalOutTreeSha256 | `86fc7089c477ef4e1117e633e9869d5ea887a408e0060884549a16c6ef1e088e` |
| Preserved originalPreviewSha256 | `f0fe3458de5aa94885e973c86df8985971d9e9d2988f1e8971f2e5f3af2c7a31` |
| Preserved originalFixtureSha256 | `c6622ae3b34e8286cc42e56d25eb9fedff31916f188c2cba829943a728c4452b` |

## Exact final local result

```json
{
  "status": "LOCAL_PROOF_BLOCKED",
  "passedChecks": 18,
  "failures": [
    {
      "case": "post-provider audit failure must allow immediate same-key recovery without second logical Checkout",
      "code": "ConflictException",
      "httpStatus": 409
    },
    {
      "case": "different concurrent event types must not regress a committed settlement",
      "code": "ERR_ASSERTION",
      "actual": "FAILED",
      "expected": "SUCCEEDED"
    }
  ],
  "fixtureSha256": "35785d3857f6fc9b01042d6dee3137eebb18950601fb1b8e7644e340be8fb83c",
  "aclSha256": "efd16d9dc554a02ae33210c9dc93fe4219b770e1ce159f53df31b6e6057c1089",
  "generatedInsertShapes": [
    "AuditLog(id,tenantId,action,actorType,actorId,entityType,entityId,metadata,createdAt)",
    "AuditLog(id,tenantId,action,actorType,actorId,entityType,entityId,metadata,traceId,createdAt)",
    "AuditLog(id,tenantId,action,actorType,actorUserId,actorUserTenantId,actorId,entityType,entityId,metadata,traceId,createdAt)",
    "Payment(id,tenantId,jobId,jobTenantId,status,requestKeyHash,requestedAt,destinationAccountId,amountTotalCents,applicationFeeAmountCents,currency,refundStatus,createdAt,updatedAt)",
    "StripeEvent(id,tenantId,stripeEventId,type,payload,processingStatus,receivedAt)"
  ],
  "mockCheckoutCalls": 6,
  "mockRecoverCalls": 1,
  "providerCalls": 0,
  "secretCalls": 0,
  "p06SourceUnchanged": true,
  "cleanup": {
    "roleClosed": true,
    "roleSessions": 0,
    "roleRemoved": true,
    "databaseRemoved": true,
    "clusterStopped": true,
    "scratchRemoved": true
  },
  "interruptionProof": "INTERRUPTION_CONTAINED"
}
```

## Handoff

Section R1-W01 / APP-013/3A/P07 stays open. Completed: tested permission map, actual connected local flow/refusals, reproducible race, verified containment and isolated browser regression. Remaining: owner decision on the atomic webhook repair and recovery-hold probe clarification, then local proof rerun and later exact image/build/runtime/external proposals. Implementer owns the repair/evidence if approved; owner owns that decision, every live action and 3A acceptance.

Progress remains **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. No helper/test/commit grants customer acceptance. Scope: approved local proof; initial browser artifact drift explicitly disclosed; isolated rerun explicitly owner-approved; proposed application repair remains unimplemented. Protected criteria, queue and denominators unchanged.

Final checkpoint checks: governance frozen baseline and cross-repository consistency pass; all25 governance safeguard tests pass; backend governance baseline, architecture, proof syntax/format and both repository whitespace checks pass. Application/P06 source, protected execution contract, finite R1 ledger and acceptance criteria are unchanged. The real-role proof remains nonzero because the two original probes are retained; these passing checks do not override the payment blocker.
