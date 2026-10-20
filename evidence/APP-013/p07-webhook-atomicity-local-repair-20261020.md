# APP-013 / 3A / P07 — approved local atomic webhook repair

Status: **implemented and locally tested; not cloud-built, deployed, live-demonstrated or owner-accepted as a payment outcome**. Owner explicitly answered “Approve focused local repair” to APP013_P07_WEBHOOK_ATOMICITY_REPAIR_PROPOSAL_20261020.md, including the existing five-minute hold's expected-result clarification. Entry heads: backend 83b7a2cb7d959e14dc32a2e4cac9baab049c45c8; governance 16f4b881a58bc22c44712b8711f0bad32fdfb506.

## Changed behavior

Previously, two distinct signed-format events could both read PENDING before their transactions. A paid event committed SUCCEEDED, then a stale failure wrote FAILED. The prior failing result and original probe remain unchanged in p07-payment-runtime-role-local-proof-20261020.md and commit 83b7a2c.

The existing webhook transaction now locks the exact tenant/payment row FOR UPDATE, rechecks the current tenant/account mapping and exact resource through the transaction, and requires the original payment/job identity before computing its final transition. Payment, bounded event and audit writes still commit or roll back together. The initial pre-transaction lookup/validation remains for malformed money/resource refusal, but its provisional state decision is discarded. Audit previousStatus now comes from the locked current state. No provider call occurs inside the transaction.

Only stripe-webhooks.service.ts, its existing spec, the existing local verifier and this evidence changed in the backend. No schema, provider adapter, endpoint, state policy, role grant, fixture permission, key, customer/booking flow or UI change. No new fee, refund transaction, SDK/API upgrade or subsystem. **No scope deviation from the owner-approved repair.**

## Current verification

- Backend production compilation passes (`npm run build`, local only; no cloud build).
- Five full affected Jest suites pass **97/97 tests**, including 29 webhook cases and 14 new regression cases. They cover authoritative current-state transition/audit, exact-row lock order, stale failure/expiry and success/refund handling, and changed account/resource/payment/job/money refusal before event writes. Existing early refusal expectations remain.
- Backend lint passes. Final architecture/governance/format/whitespace results are recorded at checkpoint close.
- The actual restricted-role PostgreSQL verifier passes **22 reported checks, failures[]**. These are unequal diagnostic checks, including a permission-count subcheck, not product acceptance units. Existing49 new and 13 original P06 SQL permission refusals stay intact. No extra grants were needed; grant fixture and tested ACL hashes are unchanged.
- The original stale-lookup counterexample still uses genuine database responses. Both initial lookups are forced to see PENDING; only scheduling is controlled. Success-first ends SUCCEEDED after the failure; failure-first moves FAILED→SUCCEEDED. Both distinct event rows must be PROCESSED, with one or two truthful transition audits respectively. This prevents making the test pass by dropping an event.
- A third real interleaving commits a full-refund observation before a stale success; final state remains REFUNDED with FULL amount/status. This is synthetic signed-event observation, not a provider refund.
- Identical-event concurrency, signature/mode/account/resource/metadata/money refusal, transaction audit rollback, populated operator reads and ordinary persisted-response recovery remain green.
- Normal and actual SIGINT-after-role-activation closeout verify NOLOGIN, limit0, past expiry, zero sessions, role/database absence, stopped owned private PG18 cluster and removed scratch. Only newly created synthetic local resources were changed; TCP and external fetch are disabled. ProviderCalls0 and secretCalls0 apply to this local proof.

## Explicitly approved recovery-hold clarification

The earlier exploratory immediate-success expectation was not an established product promise. As specifically approved, the verifier now requires Conflict409 during the unchanged five-minute PENDING reservation hold, no extra Checkout mock call and no fabricated persisted Checkout reference. After a fixture-only time advance past the existing timeout, the same key recovers the same logical mocked Checkout. No real hold is reset and the application timeout/recovery code is unchanged. The original failed-run evidence is preserved; the paid-state race's expected SUCCEEDED result was not weakened.

## Browser and historical boundaries

This backend-only transaction change does not affect the UI surface. Per the approved card, the unaffected browser regression was not rerun. Prior isolated desktop/mobile synthetic results remain in p07-payment-runtime-role-local-proof-20261020.md; they are not presented as a browser connected to this new database proof or a current live payment. The earlier staging-pinned browser artifact exception and unverified external effects remain disclosed there, unchanged. No browser/provider access occurred in this repair.

## Source and result hashes

| Artifact | SHA-256 |
| --- | --- |
| Webhook service | `fb35798fa5940e9c047c5d5e840c535efd1db64e393788c02b1f5ab7389216d0` |
| Webhook spec | `1afacb5927254aa981e9255ccf9f220b482448fbd4ba9506a41e0ad02f76ddc3` |
| Real-role verifier | `f8c5b02e8909e2b6c8d239e8f2340b414a083da69efc42bf73af0744913ca967` |
| Unchanged grant fixture | `35785d3857f6fc9b01042d6dee3137eebb18950601fb1b8e7644e340be8fb83c` |
| Private final proof output | `3927b62d24eb2ee701d30fe2442dc073768141a26de7e5f85f205a33927fa812` |

## Exact local result

```json
{
  "status": "LOCAL_PERMISSION_PROOF_PASSED",
  "passedChecks": 22,
  "failures": [],
  "fixtureSha256": "35785d3857f6fc9b01042d6dee3137eebb18950601fb1b8e7644e340be8fb83c",
  "aclSha256": "efd16d9dc554a02ae33210c9dc93fe4219b770e1ce159f53df31b6e6057c1089",
  "generatedInsertShapes": [
    "AuditLog(id,tenantId,action,actorType,actorId,entityType,entityId,metadata,createdAt)",
    "AuditLog(id,tenantId,action,actorType,actorId,entityType,entityId,metadata,traceId,createdAt)",
    "AuditLog(id,tenantId,action,actorType,actorUserId,actorUserTenantId,actorId,entityType,entityId,metadata,traceId,createdAt)",
    "Payment(id,tenantId,jobId,jobTenantId,status,requestKeyHash,requestedAt,destinationAccountId,amountTotalCents,applicationFeeAmountCents,currency,refundStatus,createdAt,updatedAt)",
    "StripeEvent(id,tenantId,stripeEventId,type,payload,processingStatus,receivedAt)"
  ],
  "mockCheckoutCalls": 8,
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

## Progress and next step

R1-W01 / APP-013/3A stays open. The local concurrency blocker is repaired and the permission boundary is tested, while repaired-source image, live payment-role/credential readiness, Stripe destination/numeric signing binding and authentic same-job Sandbox outcome still need fresh exact proposals/approvals. The old unused image contains the prior bug and is not the repaired candidate. All consumed/expired packages and prior receipts remain immutable.

Next observable preparation result: a fresh backend source archive based on the verified original 576-file archive, changing only the two reviewed webhook app files, then a concrete new image/runtime proposal. Do not run the cached archive builder in place; it overwrites old backend/UI archives. Do not replay the consumed build controller or infer deployment/payment authority from this local repair. Implementer owns fresh source/proposal preparation; owner approves applicable external actions and accepts 3A.

Accepted progress remains **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. Tests and commits do not increase these counts. No launch date or overall MVP completion percentage is inferred. No scope deviation from the explicitly approved local repair; no cloud/provider/payment action is authorized by this result.

Final checkpoint validation: frozen-baseline/cross-repository consistency, all 25 governance safeguards, backend governance/architecture, source/verifier syntax and formatting, and both repository whitespace checks pass. No earlier full-backend runtime count is represented as newly run.
