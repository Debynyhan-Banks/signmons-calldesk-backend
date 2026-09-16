# P06-R06 — partial read-only qualification

Entry sources: backend 291b4483cf846de76960950295099c7462e369da; governance 1eaaf37. Owner requested proceeding after U01. No runtime implementation, migration, secret access, provider setting, tenant mutation or paid verification in this checkpoint. No scope deviation. R06 is NOT closed.

## Verified observations

- Neon project soft-smoke-54063480, child p06-isolated-staging-v1 / br-sparkling-sun-ay6gr5e8: dashboard Free, AWS Ohio, PG18, 2/10 branches; displayed 1.89/100 CUh, 0.04/0.5GB storage, 0/5GB transfer. Metrics may be delayed; no invoice conclusion. Child fixed0.25CU active; parent idle. No plan/branch change.
- Read-only child TenantOrganization query for a1adcfd4-15be-404b-9ac3-5edb1fda20f0: SUSPENDED, updatedAt2026-09-12T22:46:30.011; organizationProfileV1.approved.approvedAt and organizationPaymentPolicyV1.approved.approvedAt null; controlledRuntimeApproval.enabled and controlledPhoneApproval.enabled null; ServiceCategory count0. This is not a full policy-content qualification. Do not infer usable organization/payment approval.
- Aggregate AuditLog query scoped to the previously approved Signmons account (SID ending c417; full identifier omitted): one conversation.staging_phone_held row, reservedMicros500000, malformed0; no controlled-phone row returned. USD0.50 reserved is not a bill or permission to reset. New aggregate ceiling must include outstanding prior liability.
- An additional address-operation aggregate query was attempted, but the filtered browser output contained no interpretable result; no zero-liability claim is made.
- Cloud Run signmons/us-east5/signmons-calldesk-staging: latestReadyRevision signmons-calldesk-staging-00065-guw; normal traffic100% on signmons-calldesk-staging-app013bounds. Existing nine tags unchanged. Template1vCPU/512Mi, maxScale1, cpu-throttlingtrue, startup-cpu-boosttrue; runtime signmons-calldesk-runtime@signmons.iam.gserviceaccount.com. No minScale annotation shown. No configuration write.
- Safari exposed Start Page, not authenticated Twilio evidence. Owner was asked to open/sign in to existing account. No new Twilio browser tab or configuration was created.

## Follow-up: existing Twilio restrictions verified; policy inputs requested

Owner opened existing Safari session. Read-only Signmons LLC account home showed Active and available balance USD19.95. Existing service (SID ending ab04f0) named Signmons exposes SMS only in service list; notes identify controlled US-only test/no customer traffic. SMS settings show Fraud Guard checked, carrier information off, landline validation off/disabled. General settings show Verify Events off. Account geographic permissions show United States SMS monitored for fraud; all other listed destinations disabled for SMS and all voice destinations disabled. No Save, send, upgrade, profile creation or secret reveal. This completes the geography/Fraud Guard readback, not account-specific price or complete R06 acceptance. Generic upgrade/profile banner is not evidence requiring another upgrade. Console also describes automatic SMS-to-RCS delivery where available; no channel configuration was changed or delivery outcome inferred.

Entry for this documentation continuation: backend d0de572; governance8bfffea; origins fetched, focused worktrees clean, backend PR21 open. Saved backend unrelated changes preserved. Source inspection: src/tenants/organization-profile.ts, organization-payment-policy.ts and src/communications/controlled-intake-authority.ts. Fictional fixture values are explicitly not deployable. Existing pilot documents establish company/contact/territory direction but no concrete approved service fee or hours were found in the inspected policy/evidence sources.

### Exact policy preparation map — not approved configuration

| Field | Proposed value or missing decision |
| --- | --- |
| companyName / timezone | Eternity Mechanical Services LLC / America/New_York, based on named Ohio pilot |
| hours / fallback | Owner must supply operating hours and after-hours response; do not promise24-hour availability |
| services / category | Propose one HVAC service-request category for this controlled journey; exact service description and durable category ID must be reviewed, not a fixture ID |
| greeting / tone | Proposed: Hello, I am the automated assistant for Eternity Mechanical Services LLC. / warm; review before approval |
| required FAQ | Proposed question: What area do you serve? Answer: Our pilot service area is Cuyahoga County, Ohio. Address verification is required before your request can be submitted. Source: owner-approved Google-only service-area policy. No response-time or appointment guarantee |
| currency / service fee | USD; owner to supply whether required and exact amount. No fictional USD1 default |
| deposit | Owner to specify none or fixed amount; no percentage-deposit support in existing slice |
| emergencyFeePolicy | Existing supported kind:none only; no invented surcharge or emergency service promise |
| payment safeguards | Existing fail_closed and webhookValidationRequired:true preserved; no waiver or paid-status inference |
| approval identity/timestamp/digests | Must come from actual authorized approval and current state; none generated by this document |
| integration/category bindings | Must be exact reviewed runtime and persisted tenant-scoped identifiers; no fixture promotion |

Owner was asked for two missing business inputs: service/diagnostic fee plus separate deposit, and operating hours plus after-hours response. These questions do not authorize a write or charge. Final complete profile/payment draft must be reviewed together before R07/R08 provisioning.

### Proposed participant notice — review only

This is a supervised Signmons staging test for Eternity, not a real service appointment. You will request one phone verification code, verify and confirm your service address, review your request and explicitly submit one test job. Phone verification does not enroll you in marketing or appointment texts. An optional correction can use one additional address check; no automatic resend. This test will not take payment, schedule, dispatch or send a confirmation message. Uncertain or expired verification stops submission. Enter private phone/address/code only in the protected test flow, not chat. Google attribution and the approved retention notice must be shown in that flow; this summary does not replace either. Current participant readiness and a fresh absolute window are reconfirmed at R10.

No policy setup has occurred. Current suspended/disabled state is preserved. Seven tasks remain; this update adds no subsection or acceptance milestone. Cost worksheet below remains provisional, with infrastructure and current account details explicitly unfinished.

## Cost worksheet — provisional, not spending authorization

| Item | Evidence / planning treatment |
| --- | --- |
| Verify | Published USD0.05 per successful verification plus USD0.0083 per US SMS; one success/one SMS USD0.0583 before unverified extras/tax/account terms. Account-specific ownership, restrictions and rate qualifications remain open. |
| Address Validation | Published Pro USD17/1000 after5000 monthly free events; Enterprise USD25/1000 after1000. Current transport sends direct ValidateAddress, no Autocomplete session; published SKU triggers support Pro for this path, not Enterprise merely because enableUspsCass=true. Two direct requests list-rate illustration USD0.034 before allowances/tax; actual billing not reconciled. |
| Neon | Current Free dashboard allowances above. No paid upgrade assumed; quota availability must be refreshed before execution. |
| Cloud Run | Resource sizing above verified. Exact us-east5 billable runtime, startup boost/restarts, requests/egress and shared free allowance still need bounded worksheet. Do not treat15minute run window as a cloud-wide billing hard cap. |
| Secret Manager | Published USD0.06/active version/month, six free; USD0.03/10000 accesses,10000 free. Five proposed new versions would be USD0.30/month before shared allowance/proration. No versions provisioned; exact release diff still required. |
| Other infrastructure | Artifact storage, build, logging, network and any retained resources must be itemized in final R06 proposal; no invented zero-cost total. Existing phone/campaign recurring fees are separate from per-run Verify. |

Official sources inspected: [Verify pricing](https://www.twilio.com/en-us/verify/pricing), [Maps pricing](https://developers.google.com/maps/billing-and-pricing/pricing), [Maps SKU triggers](https://developers.google.com/maps/billing-and-pricing/sku-details), [Cloud Run pricing](https://cloud.google.com/run/pricing), [Secret Manager pricing](https://cloud.google.com/secret-manager/pricing). Provider-directory skill attempted first; installed Stripe CLI has no directory command and directory website was not readable through tool. No installation; used official public pages.

Prior evidence google-address-live-result.md and google-semantic-live-result.md records two local USD0.10 holds (USD0.20 total), not refreshed this turn and not invoice-reconciled. Preserve both. Prior exception-identity revocation in real-phone-verification.md is historical, not fresh evidence.

Existing proposed envelope remains a proposal: one phone START, up to5CHECK, two explicit address requests (initial plus one correction),15minutes; USD0.50 new phone allowance plusUSD0.20 new address allowance. No automatic resend/retry. Prior liabilities are additional to new allowance, not erased. No final total infrastructure allowance or new run authorization is asserted.

## Remaining within R06 — unchanged deliverable

1. Implementer: Twilio account/service geography and Fraud Guard readback completed above; account-specific rate terms remain unqualified. Refresh Google restrictions, exception identity and outstanding liabilities without secrets or resets.
2. Implementer/owner: identify exact approved organization/payment policy, category and integration bindings for isolated tenant; reuse approved records where valid, never invent fee/consent/hours. Missing configuration must appear in R07 exact diff and R08 authority, not be silently written during R06.
3. Implementer: finish infrastructure worksheet and participant notice/eligibility qualification; exact readiness and absolute run window remain R10. Do not request private phone/address/OTP/password in chat.

Review: inspect these observations and remaining checks, then resume R06 read-only. Counts unchanged: original12+approvedU01=13,6 locally closed,7open; packages5/60(8.3% tracked plan),walkthrough3/8(37.5%),P06unaccepted,ETAunvalidated. No new section or acceptance milestone.

Validation: frozen-baseline check, complete cross-repository documentation consistency, backend governance check, architecture check and both whitespace checks passed; all21 governance regressions passed. Documentation-only change: no new runtime tests, build, live acceptance or browser customer-journey pass claimed.
