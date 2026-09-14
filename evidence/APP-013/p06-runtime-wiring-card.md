# P06 runtime-wiring source card — 2026-09-14

Source backend `d07ff3543b86a62112b50972a28fc89c155bf477`, governance `3c37077ba6f7c15ea6a93b90be9b376b2e09cdd7`. Owner-authorized P06 preparation only. Existing APP-013 / 2B, no new package and no scope deviation implemented.

Governance `APP013_P06_RUNTIME_WIRING_CARD.md` completes the required source/interface/test inspection before code. It maps the actual pre-parser mount, controlled composition, durable verification, address ledger/transport, current policy readers, page harness, Docker runtime and Cloud Run edge.

Newly documented gaps beyond the prior entry note:

- the P05 customer page is `scripts/fixtures/customer-intake-journey.html/.js`, has no browser phone-code step and is not copied into the runtime image;
- the transport requires same-origin Host/origin, while no deployed same-origin page/BFF is recorded;
- `LocalCustomerBrowserBudget` explicitly resets on restart and is not shared across Cloud Run instances;
- `VerificationBudgetAdmission` is fixture-only, while `StagingPhoneAdmission` is tied to the closed operator-authenticated fixed-session phone runner;
- controlled address/phone/authority policies and customer credentials exist only through injected local resources; there is no reviewed runtime loader;
- session close and phone/address browser ports remain fixture-loopback-only.

Read-only current Cloud Run metadata confirms service `signmons-calldesk-staging`, region `us-east5`, port 8080, runtime identity `signmons-calldesk-runtime@signmons.iam.gserviceaccount.com`, ingress `all`, and unchanged 100% normal traffic on `signmons-calldesk-staging-app013bounds`. Official Cloud Run contract confirms TLS is terminated before cleartext proxying to the container; arbitrary forwarded headers cannot substitute for a server-owned managed-HTTPS binding. No cloud write or secret read occurred.

The card supplies a finite recommended patch: strict default-disabled runtime envelope/loader, reviewed Cloud Run HTTPS startup attestation, distinct controlled phone admission, shared PostgreSQL-backed browser admission/budget, existing-page phone states, same-origin delivery, controlled close, and a complete negative/concurrency/restart/browser matrix. It forbids fixture promotion, client-IP claims from unqualified forwarded headers, automatic resend, provider I/O in database transactions, and any new downstream authority.

Smallest decision: owner approves the recommended same-origin backend asset packaging plus PostgreSQL-backed shared admission/budget patch, or names an existing external BFF/load-balancer path. The same decision must approve the described controlled customer admission adapter. This is implementation approval only; release/configuration, live provider calls, spending and owner acceptance remain P06 items 3–4.

This checkpoint changes documentation only. No runtime/schema/UI image/provider/configuration/customer data/traffic changed. Documentation gates are required; historical runtime/browser counts are not rerun or claimed as current evidence. Accepted packages remain 5/60 (8.3%); walkthrough 3/8 (37.5%); provisional 4–8 weeks at 25–30 collaborative hours/week plus external waits remains unchanged, low confidence.
