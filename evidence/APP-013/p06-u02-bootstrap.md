# P06-U02 — isolated staging bootstrap, local proof

Owner approved the narrowly bounded staging-bootstrap addition after the R06 source inspection. Governance APP013_P06_U02_BOOTSTRAP.md recorded the card before coding. Entry backend b699bb2117bbcb58c821d53303cb0ab254537f6c / governance 1d008f7f5a843d0015b3a195b9175cf93f3f7d5e. Exactly three exits complete; no scope deviation beyond explicitly approved U02. No live database, secret, IAM, deployment, charge or provider request.

## Change

scripts/p06-runtime-packet.mjs adds reviewBootstrap, bootstrapSettingsDigest and bootstrap exports. Existing U01 branded fixed-child/synthetic handles, database identity/history guards and action-bound owner windows are reused. New path fixes the tenant UUID to a1adcfd4-15be-404b-9ac3-5edb1fda20f0; source/packet/prestate/category/profile/regular USD99 policy are bound before mutation. Canonical settings digest tolerates jsonb key ordering, not changed content.

One row-locked transaction requires SUSPENDED, no existing profile/payment/category/job, unchanged timestamp/settings, and disabled/absent runtime/phone authority. It changes status/timezone; invokes actual OrganizationProfileService and OrganizationPaymentPolicyService save/approve methods under owner context, adapting their callbacks into the same outer transaction; creates one zero-catalog-price regular diagnosis category; adds operation audit. Existing unrelated settings/holds survive. Four existing service audits plus one bootstrap audit commit together. Final DB-clock check refuses expired execution. No new HTTP endpoint, schema or app registration.

Readback distinguishes matching historical bootstrap audit from unchanged current tenant/category setup. Suspension requires exact post-setup state, no jobs, disabled/absent runtime/phone approvals and a fresh action-bound window; retains policies/category/audits/holds and changes only status/timestamp. Never delete or compensate blindly after an unknown commit. Changed state needs review rather than automatic rollback.

## Local review interface (not a live execution instruction)

- Build the clean reviewed source first; require actual source/built-import provenance before separately authorized live use. JSON sourceRevision is a binding, not automatic attestation.
- reviewBootstrap(packet): exact fields version=1, sourceRevision(full SHA), tenantId(fixed), expectedUpdatedAt(ISO), expectedSettingsDigest, categoryId(stable UUID), profile(existing strict draft schema), payment(exact USD99 fixed deposit/no service or emergency fee).
- bootstrap(packet, authorization, handle): action bootstrap / bootstrap-readback / bootstrap-suspend. Authorization exact owner="Debynyhan Banks", action, operationId(UUID), packetDigest(from review), sourceRevision, startUtc/endUtc <=15min. This is an owner-reviewed operator record, not cryptographic authentication. No live authorization file was created.
- Handle from existing fixedChildDatabase(privatePassword) only after R07/R08 explicit credential/target/action authority; local verifier uses syntheticDatabase only. Always close in finally. No CLI implicitly opens a connection; no DATABASE_URL ingestion.
- Receipt/readback contains only nonsecret digests/status/timestamps/category/source. Exceptions are generic P06_PACKET_REFUSED_OR_UNCONFIRMED. After any uncertain result use separately authorized readback; never automatically reapply. Stable category ID is reused, not regenerated to bypass refusal.

Category 60-minute default is inert staging catalog metadata, not appointment duration or a customer promise. Deposit amount is policy-only, not duplicated as category price. Final owner profile wording and actual live prestate remain R07 packet inputs; tests use fictional text, never promote fixture approvals.

## Validation

Fresh build, lint, full Jest (2359 passed; 3 existing skips), 16 Node operator/migration tests passed. Real disposable PG18 with all26 migrations: six U02 grouped checks plus eight U01 regressions (14 total): strict target/fields/policy/owner/source/window/handle; stable jsonb digest; active authority/category refusal; late audit failure atomic rollback; expiry during transaction rollback; concurrent setup once/replay refusal/audit readback; newer settings/category suspension refusal; retained policies/category/holds after suspension. Group labels combine some assertions. Lost caller result is simulated by discarding return and reading audit, not actual network COMMIT-ACK fault injection.

No UI change: browser QA not applicable to this operator-only interface; no new live journey claimed. Governance baseline/complete consistency, 21 regression tests, architecture and both whitespace checks passed. Final local database evidence directory: /private/tmp/signmons-u01-VVZySR. Disposable database removed and owned cluster stopped by harness; no live recovery image mounted. Saved dirty backend remains untouched.

## Remaining

U02 three exits complete, review-ready. Original12+approvedU01+approvedU02=14; seven locally closed, R06-R12 remain7. Accepted packages5/60(8.3% tracked plan), walkthrough3/8(37.5%); wholeP06 unaccepted and ETA unvalidated. R06 exact IAM/resource/budget/binding qualification remains; R07 reviews live diff; R08 owns any actual setup; R10/R11 retain runtime activation/run approval. No new build/deploy is required solely for this operator-script change; pinned application image is unchanged.
