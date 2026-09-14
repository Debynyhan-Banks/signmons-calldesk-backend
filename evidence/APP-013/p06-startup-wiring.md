# APP-013 / 2B / P06 — fixed checklist item 2

2026-09-14. Owner continuation: "i reviewed proceed" after item 1. Source backend c4751d4750b37d834691838c72bf235ae8a62809 / governance e30af2ae934d1e7cbe3dceaebf2a7af587bec4bf. Authority: APP013_P06_RUNTIME_WIRING_CARD.md, existing runtime-wiring acceptance; no new acceptance section. No scope deviation.

## Outcome

Default-disabled startup wiring is locally complete, not deployed. Main now awaits `prepareControlledIntakeStartup` with the existing Nest Prisma/cipher and mounts its two handlers before CORS/parsers/listen. A startup refusal closes the Nest application before propagating the sanitized error. No fixture providers can be selected by main/environment input.

- Absent configuration or an explicitly disabled envelope produces the existing closed handlers; no intake secrets, resources or assets are accessed.
- Enabled configuration must pass the existing exact runtime/packet/tenant/window/safety checks. Facts come from explicit NODE_ENV, GOOGLE_CLOUD_PROJECT, K_SERVICE, K_CONFIGURATION, K_REVISION and PORT; no fallback to fixture/staging identities, forwarding headers or previous packets.
- `CONTROLLED_INTAKE_RUNTIME_JSON` is the server-only envelope, bounded at 32 KiB. `CONTROLLED_INTAKE_SECRETS_JSON` is separately private injected material, bounded at 8 KiB: exactly the envelope's numeric references, 64-hex purpose keys and the 32-hex Twilio token. No values in docs, source, logs or HTTP. Invalid/missing/extra material refuses. Temporary decoded buffers are zeroized on success/failure. JavaScript strings/environment values are not claimed to be erasable; runtime-owned key copies retain the existing lifetime.
- Numeric labels alone do not prove provenance: release review must independently attest the actual version-to-material mapping and separation from the conversation encryption key. No secret fetching, creation or configuration was performed here.
- Only the two fixed `customer-intake/customer-intake-journey.html` and `.js` files relative to the compiled application are read once. Missing/empty assets refuse before runtime construction; no user/environment path or directory serving. Existing Docker packaging and CSP/no-store behavior are reused.
- Existing current approval/database clock, budget, phone liability, admission and lifecycle controls remain the authority. No approval writer, schema, migration, provider request at construction, sending, payment or booking activation was added.

## Validation on this change

- Full Jest: **129 suites passed, 1 skipped; 2,359 tests passed, 3 skipped**. Seventeen new startup tests cover disabled/no-resource access, malformed configuration, explicit facts, secret shape/encoding, buffer cleanup, asset failure/fixed paths, sanitized downstream failure and main ordering. Positive unit seams are mocked only for isolated startup mechanics; positive admission evidence below uses actual services/current readers.
- Build, lint, architecture and Prisma validation passed. `npm audit --omit=dev` and full `npm audit`: zero findings.
- Complete disposable organization/database/browser harness passed and cleaned up its owned database. Existing shared-budget independent-process/concurrency/restart and phone-liability regressions passed.
- Eight loaded HTTPS browser cases now use **the same startup helper as main**, actual HTTP middleware, services and disposable PostgreSQL. Synthetic external ports only, no pre-provisioned phone proof. At 390/1440: explicit START, wrong CHECK, correct CHECK, draft/address and accepted/outside/unknown/correction outcomes. Accepted post-commit lost acknowledgment exact retry creates no duplicate job; close/reload/privacy checks preserved.
- Loaded cases: **24 synthetic phone calls, 10 synthetic address calls, four fictional jobs, zero live calls**. No storage, page errors or overflow. Mobile receipt visually inspected: job creation is explicitly not booking/payment/dispatch/messaging authority.
- Initial new unit test tried to spy on a non-configurable Node namespace export and failed; replaced with an explicit test-only filesystem mock. No application failure was hidden and no acceptance assertion weakened. Existing main-order assertion was updated to the new handler and now also requires a nonnegative match.
- Known non-failing `pg` concurrent-query deprecation warning remains in the disposable harness. This is not a new dependency audit finding.

Logs: `/private/tmp/signmons-p06-startup-{build,lint,tests,db}.log`. Screenshots: `/private/tmp/signmons-p06-startup-evidence/loaded-{accepted,outside,unknown,correction}-{390,1440}.png` and `loaded-phone-{390,1440}.png`. Temporary artifacts may expire; reproducible commands below are authoritative.

## Exact review/reproduction

1. Review main/startup/spec, `.env.example`, changed browser harness and this evidence on the focused backend branch. Check that the example remains `{"enabled":false}` and main supplies only Nest resources.
2. From backend run `npm run build`, `npm run lint`, `npm test -- --runInBand`, `node scripts/architecture-check.mjs`, `npx prisma validate`, `npm audit --omit=dev`, `npm audit`, `git diff --check`.
3. Run `ORGANIZATION_EVIDENCE_DIR=/private/tmp/signmons-p06-startup-evidence PLAYWRIGHT_MODULE=/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node scripts/verify-organization-profile.mjs`. This script guards and owns only a disposable local database; do not substitute a real tenant/database or provider ports.
4. Run backend `SIGNMONS_GOVERNANCE_REPO=/private/tmp/signmons-2b-bootstrap-gov node scripts/check-governance-baseline.mjs`; governance frozen/full consistency and 21 regression checks. Inspect the synchronized fixed checklist/current pointers.

## Remaining fixed checklist and acceptance

Items 1 and 2 locally complete. **Only items 3 and 4 remain:** exact release packet/owner review, then separately approved capped staging execution/acceptance. Release packet must identify image/revision/origin, actual secret-version injection, current tenant policies/rates/caps, participant/window and exact resource/configuration/ingress diff. This turn does not authorize those actions or a paid retry. Local preview copy remains truthful; no claim of a deployed customer UI.

No merge, deployment, cloud/provider configuration, real credentials, charge, customer record or appointment changed. Owner/release reviewer owns item 3 decisions; owner separately authorizes item 4 execution. Next observable result is one reviewable release packet, not another coding section. Accepted packages remain **5/60 (8.3%)**, walkthrough **3/8 (37.5%)**, not whole-MVP completion. Provisional **4–8 weeks at 25–30 collaborative hours/week plus external waits**, low confidence, unchanged; next timing audit at ten accepted packages.
