# P06-R06 — partial read-only qualification

## Consolidated review draft

Governance APP013_P06_R06_REVIEW_PACKET.md consolidates proposed resource delta/costs/rollback and explicitly unresolved execution fields. Registry describe freshly confirms pinned image sha256:ea47a8371a04f773a5c51fc4f939250b7045eba92d3cbbeb68e49ceb0240be35 in us-east5; no new build needed. Secret version metadata shows existing Twilio token version1 enabled; payload correctness/account correspondence is not claimed. Live serviceUsageConsumer role definition inspected; it includes serviceusage.services.use plus read-only service/quota/policy/monitoring permissions, not a single-permission role. No grant made. Entryc0b19af/a37452b; focused origins fetched. No runtime code or external write. Draft is not execution-ready; R06 stays open. No scope deviation.

## Latest child ledger and resource-cost worksheet

Entry backendd07f534/governance947384a. Focused origins fetched, no unrelated changes touched. Existing Chrome Neon tab confirmed fixed child br-sparkling-sun-ay6gr5e8 / ep-jolly-flower-ayc6w9hv / neondb before SELECT. Query count/sum across AddressVerificationOperation plus AddressVerificationRequest count returned operations0,held_micros0,request_claims0. No customer rows or payloads read. Returned tab to Dashboard. Prior no-result ambiguity is now resolved; this does not erase the separate prior phoneUSD0.50 or local GoogleUSD0.20 holds.

Cloud Run metadata unchanged: latestReady00065-guw, normal traffic100%app013bounds, nine existing tags retained,1vCPU/512Mi. DEV_AUTH_ENABLED,SCHEDULING_ENABLED,SMS_DELIVERY_ENABLED,BACKGROUND_WORKERS_ENABLED,STAGING_PHONE_TEST_ENABLED allfalse. Other flags are not inferred by this filtered query. Existing13secret names include prior phone/session/digest, not the proposed controlled-intake bundle/customer-purpose keys/child database resource. Secret names/references only; no version payloads. Existing DATABASE_URL reference remains latest; cannot use it as a verified numeric child binding.

### Incremental infrastructure planning (USD, before shared allowances/tax)

| Component | Calculation / treatment |
| --- | --- |
| Cloud Run active compute | us-east5 is Tier1.1vCPU/0.5GiB for900billed seconds:900*0.000024+450*0.0000025=0.022725. Per-request price0.40/million. Startup boost, shutdown, repeated cold starts, disabled-candidate validation and closeout add billable time. This is a scenario estimate, not a hard cap. |
| Secret Manager | Existing worksheet rates: five proposed active versions at0.06/month=0.30/month gross, plus0.03/10000 accesses. Existing13secret resources mean no assumption that free versions remain. Count actual versions in final release packet. |
| Logging |0.50/GiB ingested beyond50GiB/project/month, includes30days; illustrative10MiB additional logs is0.004883 gross. No claim of actual volume or remaining free quota; do not log private inputs. |
| Artifact storage |0.000136986/GiB-hour above0.5GiB billing-account allowance. Reusing the approved existing image entails no new build/image upload; pre-existing storage continues. New build would require a revised itemized release proposal. |
| Image transfer | Same-location repository-to-runtime transfer published free; cross-US/Canada locations0.01/GiB when no free rule applies. Exact repository location/size must be bound in release diff, not assumed. |
| Neon | Existing Free child0.25CU; displayed1.89/100CUh,0.04/0.5GB,0/5GB transfer.15minutes compute adds0.0625CUh plus setup/closeout. No upgrade or paid plan assumed; dashboard metrics delayed. |
| External network | Cloud Run outbound to Neon/Twilio follows Premium network pricing; shared North America1GiB allowance cannot be assumed unused. Metered bytes/destinations still required for final allowance. |
| Excluded actions | No new cloud build, backup, migration, paid tier, phone number, SMS confirmation, Stripe payment, email or AI call in P06 run scope. Existing account recurring charges are not incremental test cost or cancelled by this plan. |

Sources refreshed: https://cloud.google.com/run/pricing (regional tiers and request pricing), https://cloud.google.com/artifact-registry/pricing, https://cloud.google.com/products/observability/pricing. Provider-directory skill checked first; CLI command unavailable; no installation. Public rates do not verify negotiated account charges.

Proposed new verification allowance remains0.70 (phone0.50+address0.20), separate from0.70 prior holds. No new spending permission. A final release allowance must include setup/closeout, network and retained-secret costs, not simply the0.022725 compute example. Do not promote R06 complete or request a paid run yet.

Remaining deliverable: assemble exact nonsecret tenant/category/integration/provenance and runtime access disposition plus total itemized release allowance for R07. Resource creation/numeric versions are R08 actions after exact approval, not facts to fabricate now. No new subsection;6closed/7open unchanged. No scope deviation.

## Latest Google quota and exception-identity readback

Entry backend83a4228/governanceca2b7b8; both origins fetched, focused checkouts clean. Read-only requests used existing owner gcloud access token in process memory only, never printed/persisted. No old test runner was executed, no impersonation or provider validation request.

- gcloud services list confirms addressvalidation.googleapis.com enabled.
- Service Usage consumerQuotaMetrics FULL response HTTP200, no next page: validate_address_requests project effective limits5/minute and10/day. Per-user minute value9223372036854775807 is not an additional practical cap. Feedback quotas are separate and unused. Daily quotas are not one-run allowances and can reset; durable holds/caps remain required.
- Identity Toolkit accounts:lookup HTTP200 for only staging-phone-owner-20260912: disabled:true, validSince1789253204 unchanged. No email, phone or custom claims retained. This is disabled/revocation-timestamp readback, not a fresh token-replay test.
- Runtime service-account resource IAM policy bindings empty. Direct project membership for that runtime shows only roles/firebaseauth.viewer. Project get-ancestors returns signmons project only, no parent organization/folder.
- Effective serviceusage.services.use troubleshooting refused because policytroubleshooter.googleapis.com is disabled. Did not enable API, install CLI components, grant roles or access secret payloads. Beta quota command unavailable without component installation; quota read completed through existing authenticated Service Usage REST instead.

Conclusion: current quota and old exception closure now verified. No usable Address Validation authorization for the runtime has been demonstrated. Project API enablement and owner access do not establish runtime access. R07 must explicitly review the necessary exact least-privilege grant, if required, alongside release configuration; no broad Editor/Owner grant or downloaded key. Do not treat unavailable troubleshooting as proof of every possible effective denial.

Remaining R06 work is final database-liability/binding and itemized infrastructure-cost qualification plus exact runtime-authorization disposition. No further business-price/hour/scope question is pending. R06 not closed;6locally closed/7open, packages5/60,walkthrough3/8. No scope deviation. This was read-only metadata evidence, not successful phone/address/job acceptance.

## Approved regular-only scope and fresh safety readback

Owner explicitly approved the proposed regular-visit-only controlled test with one USD99 deposit. Governance ETERNITY_PILOT_OPERATING_RULES.md now records exact restricted policy content. Earlier pending-scope language below is historical and superseded; do not ask for this decision again. No tenant/policy write or paid run is authorized.

Read-only sanitized jq of the two already-known local Google held files returned project signmons, liabilityMicros100000 each and original claimedAt1789257509515/1789258273539. Both holds remain USD0.20 total; no reset, removal or invoice reconciliation. Requested requestLimit field was absent/null, so no new request-count conclusion. No private address/input files opened. Read-only gcloud IAM role describe returned stagingPhoneTokenSigner stageDISABLED. This does not independently refresh operator disabled/revoked status or other bindings.

Entry backendd3b3633/governance8196055; both origins fetched and focused worktrees clean. R06 still open for current Google access/quota, exception identity, complete DB liability and final infrastructure/binding qualification. Existing R07-R12 unchanged; no new task or scope deviation.

## Latest owner-policy resolution

Owner supplied USD99 regular diagnosis deposit, USD150 replacement for every after-hours emergency including Sunday, and Eastern hours Mon-Fri07:00-19:00/Sat09:00-17:00/Sunday emergency-only. No immediate dispatch guarantee; otherwise collect for business-hours follow-up. Governance ETERNITY_PILOT_OPERATING_RULES.md is the current business-rule record; earlier missing-input rows below are historical and superseded. No runtime approval timestamp or policy write inferred.

Inspected organization-payment-policy.ts, job-payment-policy.service.ts and payment-requests.service.ts: current fixed-policy implementation has no after-hours selector and adds deposit plus service fee if both are enabled. Never configure99+150. Proposed regular-only first controlled test uses a single9900-cent deposit with service fee disabled; this restriction requires owner approval and does not implement the full emergency rule. Full hours/replacement behavior stays documented for separately approved implementation. No code, charge or deployment in this update. Counts unchanged6closed/7open; R06 remains partial. See governance record for alternatives and future acceptance checks.

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
