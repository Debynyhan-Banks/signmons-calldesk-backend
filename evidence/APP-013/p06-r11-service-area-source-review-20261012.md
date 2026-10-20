# APP-013 / 2B / P06-R11 — street-record compatibility review

## Authority and evidence

October 12 owner “proceed” authorized the proposed local source/existing-test review after exact-request reconciliation. This record proposes a behavior change; it does not authorize implementation or external actions.

Pinned source root `/private/tmp/signmons-correction-readiness-source-20261011`, source SHA `3cf8a9dc53d0282a35e6263a36d749c5b32f8e2e`, image `sha256:69ef032639e5dcfa2bcaaa5d88d0e438ec62903f08cb44fc5572af1209e332d3`. The six inspected evaluator/adapter/verification-service source and test files match the source manifest and current focused backend copies. Preserve unrelated dirty work.

`controlled-intake-verification.service.ts:189-255` first requires an address REVIEW result, then calls the shared service-area evaluator. UNKNOWN becomes SERVICE_AREA_NOT_CONFIRMED; resolved outside becomes OUTSIDE_SERVICE_AREA. Thus the observed browser category narrows the failed gate but does not identify which evaluator condition failed. The first operation can produce this result without a correction round trip.

`google-service-area.ts:75-84` rejects every addressRecordType other than H. Its successful fixtures and existing connected browser fixtures use H. Google's official reference defines H as building/apartment, S as a street record with a valid primary-number range, and F as firm. Therefore an otherwise qualifying S response is necessarily rejected by the existing predicate. This is a demonstrated compatibility restriction, not proof that the historical Google response had S. Missing physical flags, county evidence, conflicting values or expired context can also return UNKNOWN. The response is not retained, and no retrospective provider query is authorized.

Source: https://developers.google.com/maps/documentation/address-validation/reference/rest/v1/TopLevel/validateAddress#UspsData (reviewed October 12). The same reference says missing metadata.poBox is unknown; preserve that rejection. Original `evidence/APP-013/google-service-area.md` expressly described physical-record fixtures as hypotheses and other record types as unsupported.

Existing focused tests executed against pinned source: `node node_modules/jest/bin/jest.js --runInBand --no-cache --runTestsByPath src/communications/google-service-area.spec.ts src/communications/google-address.adapter.spec.ts src/communications/controlled-intake-verification.service.spec.ts`: 3 suites/179 tests pass. This confirms existing coverage only; no new S fixture or runtime patch was created.

## Alternatives and recommendation

1. Approve one local compatibility change adding S to the existing H allowlist, plus connected synthetic verification. Recommended smallest demonstrated gap. All other types including F remain unsupported under this bounded change; full commercial-type support is not claimed.
2. Keep current behavior and pause. Future live diagnostic capture would require separately approved privacy, provider costs and execution scope; no diagnostic subsystem is proposed here.

## Proposed section card — pending owner decision

Section stays APP-013 / 2B / P06-R11. Existing customer workflow requirement: a valid confirmed physical address with consistent US/OH/Cuyahoga evidence and current phone/session/policy proofs can proceed through the same reviewed-job admission path. Local acceptance for this delta: an otherwise identical qualifying S response follows the existing H path; unsafe/missing/conflicting evidence still refuses. No new acceptance section, queue change, provider, dependency or denominator.

Expected files: `src/communications/google-service-area.ts`, its existing spec, `controlled-intake-verification.service.spec.ts`, and the existing synthetic browser/DB fixture in `scripts/verify-loaded-intake-browser.mjs` if required to cover S through the connected journey. Reuse adapter, service, admission/ledger and existing tests/harness. Do not change public interfaces, error categories, parser matching policy, county code/name table or provider transport. If another runtime file or policy relaxation proves necessary, stop with a separate demonstrated gap.

Boundaries: unchanged tenant/session/conversation/request/address-revision/policy/organization identity; current phone/address proof and operation deadlines; explicit user review; unit resolution; US/OH/Cuyahoga agreement; PO-box/CMRA/private-mailbox rejection. No retained Google content, new field, log, receipt type, schema, secret or provider I/O. Default-disabled state, atomic single-job consumption, exact replay and existing reservation ceilings remain intact.

Finite checklist after approval:
1. Capture the before hashes/delta and add S to H only. Use typed exact-string comparison; malformed/unknown/lowercase/empty types remain UNKNOWN.
2. Extend existing tests with otherwise identical H/S positives, Cuyahoga and adjacent-county classifications, missing/conflicting county/state/country, mailbox flags, missing/invalid unit, changed address and expired/foreign binding negatives. Preserve F/G/P/R and malformed-type rejection. Ensure S alone never grants authority.
3. Exercise S through the existing verification-service and loaded browser-to-job synthetic path at390/1440. Reuse existing duplicate/concurrent exact request, stale proof, failed observation, late provider, lost acknowledgement and rollback recovery cases. Clear S can create exactly one fictional job after all existing gates; no negative can gain admission. No new demo or provider calls.
4. Run focused and full tests, lint/build/architecture, existing disposable DB/browser gates, governance and whitespace checks. Record precise results and cleaned-up local resources; stop at local review readiness.

Commands: `npm test -- --runInBand src/communications/google-service-area.spec.ts src/communications/google-address.adapter.spec.ts src/communications/controlled-intake-verification.service.spec.ts`; `npm test -- --runInBand`; `npm run lint`; `npm run build`; `npm run arch:check`; `node --check scripts/verify-loaded-intake-browser.mjs`. Reuse `scripts/verify-organization-profile.mjs` with an owned disposable socket-only PostgreSQL cluster, installed browser harness and fictional provider ports, never live DATABASE_URL/DIRECT_URL. Run required backend/governance baseline, consistency, safeguard and whitespace checks before/after. Inspect the existing harness invocation before execution; local prerequisites unavailable means report that gate incomplete.

Owner approves the allowlist policy expansion and this finite local scope before coding; implementer owns patch/tests/evidence. No new attended window or Twilio balance is needed for local work. Build/upload/deployment, live database access, new journey, provider charges, changing holds/caps and credential actions are excluded and require separate approval. No estimate of live success is made.

Rollback: revert only the isolated proposed delta; preserve prior approved fixes and closed runtime. Observable finish: reviewable patch, connected fictional S positive and retained negative/concurrency/recovery results, no extra provider call or duplicate job. Dependencies/counts unchanged; finite effort is one predicate plus existing test fixtures, not a new subsystem.

## Handoff

Completed: source and official-contract review; six-file provenance comparison; 179 existing focused tests. Remaining: owner decision on Alternative1 or pause, then proposed local checklist1–4. Blocker/owner: adding S changes the supported-record policy and needs explicit owner approval under repository AGENTS.md change control. Next observable result after approval is a locally tested patch, not another live attempt. P06 remains12/14; R11/fullR12 open; accepted1A/1B/2A remain3/8. Scope deviation proposed above, not implemented. No application source edits, new synthetic tests, live data/provider calls, deployment or acceptance claim occurred.
