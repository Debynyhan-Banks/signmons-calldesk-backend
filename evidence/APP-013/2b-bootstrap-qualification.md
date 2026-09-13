# 2B bootstrap qualification — 2026-09-13

## Follow-up: ingress and parser placement

At source 99ba2ac, official Cloud Run documentation confirms edge TLS termination and HTTP delivery to the container. Live read-only metadata shows ingress all, port 8080/http1, latest-ready 00065-guw. The 2B card now distinguishes explicit managed-ingress configuration from direct socket TLS and rejects client forwarding headers as standalone trust evidence.

Nest core lockfile 11.2.3 tagged source supports registering the narrow streaming customer handler before init/default parsers. Proposed main.ts placement precedes CORS, wraps request context, caps raw input before parsing, and handles its own sanitized no-store errors. Other routes pass through untouched with rawBody:true; Stripe/Twilio signatures must retain exact original bytes. No runtime handler was added. Integration tests remain required for limits/abort/spoofing/context and unrelated parser preservation. Installed 11.1.18 in the saved checkout is not accepted as locked-version proof.

See governance APP013_2B_IMPLEMENTATION_CARD.md, Ingress and pre-parse design qualification, for official source links, finite tests and remaining configuration/retention/approval gates. This is design qualification, not activated security or accepted 2B behavior.

Documentation-only source inspection at cc4a486. See governance APP013_2B_IMPLEMENTATION_CARD.md, Bootstrap source qualification, for the finite adapter design and remaining gates.

Confirmed: WebchatIntegrationGuard requires a bearer integration credential; CustomerConsentBrowserTransport rejects Authorization/Cookie and requires trusted integration context, strict same-origin/HTTPS/peer facts and bounded raw JSON. They cannot be wired directly for a customer browser. Proposed reuse is one same-origin controlled server adapter with an approved server-owned tenant mapping, session capability and separate Firebase operator review. No browser integration key, invented identity headers, global CORS weakening or unconditional TLS flag.

main.ts rawBody retention does not itself prove pre-parse bounds; Cloud Run HTTPS does not prove container socket TLS. Exact trusted ingress/raw-body composition, activation binding and purpose-bound runtime key references remain qualification gates. Existing operator controller is unregistered and customer credentials lack a runtime loader. Historical closed phone identity/proof is not fresh admission authority.

Read-only Cloud Run: latest-ready signmons-calldesk-staging-00065-guw, phone-preflight tag; normal traffic 100% signmons-calldesk-staging-app013bounds. No change, request to verification providers, secret read, activation, send, deployment or migration. No runtime code changed. APP-013/2B remains Now; 3/8 walkthrough accepted (37.5%), not whole MVP. No scope deviation.

The previous temporary worktree Git links were absent. Fresh isolated worktrees were created from exact remote feature heads; old directories and dirty saved checkouts were left untouched. No recovery/reset of provider holds.

Validation: governance frozen baseline, complete cross-repository consistency and all 17 baseline/placement/alignment tests passed. Backend architecture and cross-repository safeguard checks passed; whitespace passed in both worktrees. No runtime/UI change, so runtime tests/lint/build/browser QA were not rerun or represented as new acceptance.
