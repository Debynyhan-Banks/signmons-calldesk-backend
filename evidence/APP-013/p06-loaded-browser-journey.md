# APP-013 / 2B / P06 fixed checklist item 1

2026-09-14, from backend 94e81be / governance a43865e. No scope deviation. Browser-driven phone-code -> address -> job locally complete, not live demonstration or owner/package acceptance.

## Implemented

- Existing page receives a server-held code-request notice/version at protected bootstrap. Existing verification controls use controlled START/CHECK, not fixture NOTICE/STATUS/proof routes. Explicit code request, locked phone after START, wrong-code/correct-code states, no automatic resend. Changing a started number closes the session; packet start limits are not reset. Code input clears after response; no browser storage.
- Server notice projection contains only bounded version/text; no credentials/provider IDs. Existing transport/admission remains authoritative. An accepted code is not payment, booking, messaging consent or job authority; final controlled admission rechecks current proof/policy.
- New verify-loaded-intake-browser.mjs uses actual loader, HTTPS middleware, same-origin asset middleware, protected services, shared budgets, durable verification, address composition and disposable PostgreSQL. It supplies only synthetic external SDK/fetch ports. No phone proof is provisioned before browser interaction; each browser creates its own protected session and enters codes.

## Actual result

Eight loaded-browser cases: accepted, outside, unknown and correction at 390/1440. Each requests one code, checks one wrong code and one correct code. Accepted lost acknowledgment requires an explicit exact retry, returning the same receipt without another job/address/phone invocation. Outside and unknown create no job; explicit correction creates exactly one job after the second address request. Close/reload clears private state, no browser storage/overflow/page errors. Loaded cases total 24 synthetic phone and 10 synthetic address invocations, four synthetic jobs; zero live provider calls.

The first run exposed shared synthetic account ceilings between test cases; later cases exercised exhaustion instead of the intended provider outcome. Each case now has distinct synthetic phone/address accounts, with explicit expected invocation assertions. No existing hold is reset/deleted to make a case pass. Full corrected suite passed.

## Validation / artifacts

- Build/lint/architecture/schema passed; full Jest 128 suites passed/one skipped, 2,342 tests passed/three skipped. Both npm audits zero findings.
- Full existing guarded database/browser suite passed with new loaded-browser cases, including prior concurrency/restart/rollback/consent/retention gates. Existing non-failing pg concurrent-query deprecation warning remains.
- Local HTTPS uses an ephemeral synthetic certificate/key created in an owned temporary directory and removed after tests. No provider credential generated, fetched or configured. TLS trust bypass is local Playwright test configuration only.
- Logs /private/tmp/signmons-p06-browser-{build,lint,tests,db}.log; screenshots /private/tmp/signmons-p06-browser-evidence/loaded-{mode}-{width}.png and loaded-phone-{width}.png. Mobile receipt visually inspected. Fixtures contain fictional customer data only.
- Main still invokes customerSessionHttp() and customerIntakePage() unbound. No environment activation, deployment, production migration, billing, real customer records or main merge.

## Review / fixed checklist

Review controlled notice/transport projection, existing HTML/JS verification branching and the loaded HTTPS verifier. Re-run full runtime-card commands; inspect accepted/phone screenshots and loadedBrowser log records showing preprovisionedPhoneProof:false. Governance frozen/full consistency, 21 regressions and whitespace gates required before push.

- [x] 1. Browser-driven phone-code -> address -> job (local implementation/synthetic proof).
- [ ] 2. Default-disabled startup wiring.
- [ ] 3. Release packet and owner review.
- [ ] 4. Approved capped staging test and acceptance.

Three concrete tasks remain, not three broad sections. Accepted remains 5/60 (8.3%), walkthrough 3/8 (37.5%). Provisional 4–8 weeks at 25–30 collaborative hours/week plus external waits remains low confidence; next timing review at ten accepted packages.
