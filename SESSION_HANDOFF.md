# Backend Session Handoff

Last Updated: 2026-09-08

## Current Program Pointer

- Active ticket: `APP-013` Twilio-backed notification center and transactional customer messaging.
- APP-012 is owner-approved, merged and released from PR `#14` at `068f4c2`.
- APP-011 is owner-approved, merged and released from PR `#13` at `28d394f`.
- Keep the WIP limit at one; APP-013 is active on the focused transactional-messaging branch.

## APP-013 Transactional Messaging Foundation (2026-09-08)

### Latest: Soft-deleted customer-management access safeguard

- Owner approved the identified next priority; fetched/reconciled backend `d1a18ff` / governance `4d5ab99`, APP-013 sole Now. Both focused boards selected one bounded soft-deleted customer-management access section before coding. Unrelated saved changes preserved.
- loadAppointment now filters id + tenantId + deletedAt:null and defensively rejects any returned deleted row. A valid management bearer token cannot expose a record already soft-deleted when loaded. Deleted, missing and cross-tenant lookups share the existing HTTP 400 / Appointment not found response, before journal/legacy status disclosure, activity lookup or any of the seven management actions. No new public error code or deletion flag.
- Customer page action and payment error paths now clear stale booking data on HTTP 400 as well as the existing 409. The payment error path still closes its blank tab and never navigates to a checkout on refusal. This intentionally also clears stale data for other 400 validation failures; the customer must refresh/reopen rather than continue from an invalid snapshot. No payment-policy or provider integration change.
- Twelve added unit cases cover all seven actions, uniform missing/deleted refusal, exact tenant/deleted query predicate, no downstream activity and deletion across five lifecycle states. Three real PostgreSQL active/terminal scenarios prove a token works before deletion, then all seven actions refuse for deleted/missing/cross-tenant identities (63 refusals), with exact row preservation and no new audit, intent or communication event.
- Backend lint/build, 55 suites/656 tests (3 existing skipped tests), architecture/Prisma and disposable 15-migration suite pass; all 11 prior real process-crash cases remain passing, no new crash case claimed. Fixture database dropped and absence independently verified; zero real provider calls.
- UI lint/type check, 60 tests and 14-page build pass. All five desktop/390px browser harnesses pass: 22 framework route checks/12 home navigations/static manifest; customer/dispatch, technician, policy, notification requests 30/14/8/92. New checks cover initial deleted/missing refusal, stale-action cleanup and stale-payment cleanup/blank-tab closure; screenshots visually reviewed. Zero external requests/page errors. All four backend/UI full/omit-dev audits remain zero.
- Limit: this closes already-deleted-at-load access and clears stale UI on a refusal; it is not push revocation of an already-rendered page or serialization of deletion against requests already in flight. Undeleted terminal history and existing token/tenant gates remain unchanged. No deletion endpoint, hard-delete, data repair, token-key rotation or audit-retention change.
- Remaining: legacy dispatch/technician/message guards and repair; authorized CREATE journal orchestration with explicit reader/worker/review ownership; post-read/provider races, reschedule/cancel and SENDING recovery, dependency override/in-place limitations, future upload gates and acceptance. No schema/dependency/module/provider-adapter changes, migration outside disposable fixtures, real-data action, secrets/IAM/billing, charges, external sends, merge, deployment or activation. Planning estimates unchanged APP-013 ~85%; governed APP-006 through APP-016 ~81%. Stop review-ready.
- Exact commands/limits: `evidence/APP-013/readiness-report.md` and `deleted-booking-summary.json`.

### Earlier: Legacy CREATE customer-management safeguard

- Owner requested continued remediation; fetched/reconciled backend `fd68377` / governance `83aaad4`, APP-013 sole Now. Selected one bounded customer-management safeguard for legacy CREATE reservations; both focused boards recorded this scope before coding. Unrelated saved changes preserved.
- After signed management-token/tenant validation and the existing unfinished-journal gate, SchedulingService now returns a fixed office-review 409 for ACCEPTED jobs with a reserved start or end but no nonblank Calendar reference. All seven management actions stop before serializing provisional details, reading activity history, recovering payment, reserving/changing Calendar or recording customer actions. A valid link is not confirmation proof.
- Fourteen added unit cases cover every action, partial windows, blank references, unscheduled payment-recovery compatibility and cancelled/completed historical viewing. Existing finalized-booking tests remain passing. The three prior real PostgreSQL unknown-CREATE cases now test all seven management actions (21 refusals), cross-tenant rejection, no journal row, exact held-row preservation and zero new success audit/intent/message.
- Backend lint/build, 55 suites/644 tests (3 existing skipped tests), architecture/Prisma and disposable 15-migration suite pass, retaining all 11 prior child-process crash cases. No new process-crash claim. Zero real provider calls; fixture database removed and absence independently verified.
- UI rendering code unchanged; the calendar browser harness now covers initial legacy hold and settled-to-legacy conflict, including removal of stale details/actions, at 1440/390 pixels. All five harnesses pass: 22 framework route checks/12 home navigations/static manifest; customer/dispatch, technician, policy and notification requests 20/14/8/92. Zero external requests/page errors. Legacy desktop/mobile screenshots visually reviewed. UI lint/type check, 60 tests and 14-page build pass; all four backend/UI full/omit-dev audits remain zero.
- This is a customer-boundary snapshot guard, not global serialization or recovery. Unscheduled jobs, terminal historical views and records with a Calendar reference are not newly classified as pending. Dispatch/technician/message handling of unjournaled reservations, legacy repair and post-read races remain open. Inspection also found loadAppointment lacks an explicit deletedAt filter; soft-deleted management-link access needs a separate bounded review/fix before acceptance.
- Authorized CREATE journal orchestration with upstream guards and explicit reader/worker/review ownership, reschedule/cancel and SENDING recovery, external-state races, override/unused in-place-API limitations, future upload gates and acceptance remain open. No schema, dependency, module registration, payment-policy or provider-adapter change; no new migration, real data, external sends, secrets/IAM/billing, charges, merge, deployment or activation. Planning estimates unchanged APP-013 ~85%; governed APP-006 through APP-016 ~81%. Stop review-ready.
- Exact commands and limits: `evidence/APP-013/readiness-report.md` and `legacy-create-customer-summary.json`.

### Earlier: Initial CREATE uncertainty safeguard

- Owner requested continued risk remediation; fetched/reconciled backend `606a803` / governance `48b7521`, APP-013 sole Now. Selected one bounded CREATE-path safeguard before authorized journal integration: remove legacy compensation after an unknown initial Calendar insert outcome. Existing focused branches only; unrelated saved changes preserved.
- SchedulingService now retains the local reservation on every insert exception instead of resetting the job/window to CREATED and inviting another booking. It returns a sanitized 503 requiring office confirmation; no finalizer, success audit, notification, compensating Calendar request or second insert follows. Logging uses only fixed event text plus tenant/job identity, omits the raw error and cannot replace the response when logging itself fails.
- Fifteen added Jest cases cover seven outcomes with healthy/failing logging (timeout, connection loss, provider 500/400, malformed JSON, missing ID, credential failure) plus failed availability preflight before any reservation. Three real PostgreSQL cases cover pre-insert failure, synthetic event followed by lost acknowledgment, and a newer office edit before failure. Exact held rows survive; fresh service instances reject same/different signed-window retries without reinsertion; no intent/message/success audit is created.
- Backend lint/build, 55 suites/630 tests (3 existing skipped tests), architecture/Prisma and disposable 15-migration suite pass, retaining all 11 prior actual child-process crash cases. This section adds database failure cases, not new process-crash coverage. Zero real provider calls; fixture database dropped and absence independently verified.
- UI unchanged: lint/type check, 60 tests, 14-page build and five desktop/390px browser harnesses pass; 22 framework route checks/12 home navigations/static manifest and 14/14/8/92 mocked requests. Zero external requests/page errors. Backend/UI full/omit-dev audits remain zero findings. Dependencies, schema, module registrations, provider adapters and payment policy unchanged.
- Tradeoff: even a failure before dispatch or a definite rejection is conservatively held because this legacy boundary does not expose trustworthy no-insert evidence. This can block a slot until office review. No new durable journal/event ID, review queue/control, automatic recovery, global provisional-state guard or historical repair is added. Retention of the reservation prevents this rollback/reinsert path only; other mutation paths and external races are not globally serialized.
- Remaining: authorized CREATE journal orchestration with upstream tenant/auth/payment/availability guards and explicit reader/worker/review ownership; legacy visibility/repair, reschedule/cancel and SENDING recovery, external-state races, override maintenance, known unused Prisma in-place aliasing, future upload limits/error mappings and acceptance. No migration outside disposable fixtures, real data, provider/secrets/IAM/billing configuration, charges, external sends, merge, deployment or activation. Planning estimates unchanged APP-013 ~85%; governed APP-006 through APP-016 ~81%. Stop review-ready.
- Exact review commands, evidence and limitations: `evidence/APP-013/readiness-report.md` and `create-uncertainty-summary.json`.

### Earlier: Scoped Google/UUID dependency remediation

- Owner requested continued remediation; fetched/reconciled backend `d05eb9a` / governance `bb7bcde`, APP-013 sole Now. Explicitly selected one bounded Google/UUID dependency section on the existing focused branches; unrelated saved changes preserved.
- Exact-parent overrides for `gaxios@6.7.1`, `google-gax@4.6.1` and `teeny-request@9.0.0` select `uuid: 11.1.1` instead of 9.0.1. Exactly one lock entry changes. Firebase Admin 13.10.0, Google clients, Prisma/Nest, prior overrides, runtime application source, UI and schema remain unchanged. This is a reviewed major transitive-library exception, not a Firebase upgrade.
- Installed 9.0.1 reproduced silent partial writes with tiny v3/v5 output buffers. Fourteen new native checks run automatically through Jest: exact CJS/ESM consumer resolution, v4 IDs, v3/v5/v6 integer bounds before writes and exact-boundary success, actual google-gax request-ID helper, gaxios/teeny multipart formatting via synthetic transports, and unchanged Firebase initialization/malformed-token refusal without credentials. Socket creation is forbidden in this fixture.
- Clean install, backend lint/build, 55 suites/615 tests (3 existing skipped tests), architecture/Prisma and disposable 15-migration suite pass, including 11 prior actual process-crash cases. Zero real provider calls; temporary database dropped and absence independently verified.
- UI unchanged: lint/type check, 60 tests, 14-page build and five desktop/390px synthetic browser harnesses pass: 22 framework route checks/12 home navigations/static manifest; customer/dispatch, technician, policy and notifications 14/14/8/92 mocked requests. Zero external requests/page errors; temporary missing-link mobile and notification desktop screenshots visually reviewed.
- Fresh post-build backend full/omit-dev audits now both pass with zero findings (baseline full audit 0 high/8 moderate); UI full/omit-dev also zero. The previously open audited Firebase/Google/uuid findings are absent. This clears the current dependency-audit failure, not comprehensive security acceptance, deployed remediation or APP-013 completion.
- APP-013 owns all three exact-parent exceptions. Re-review on any parent/Firebase change; remove once native dependency resolution is patched and consumer/bounds/application/PostgreSQL/browser gates pass. The inspected consumers use zero-argument v4 only. UUID v11 changes timestamp-options state semantics/types and packaging; those APIs are not assumed universally compatible. No upstream Google endorsement of this override, valid-token provider acceptance or exhaustive numeric-input/resource-safety claim.
- Remaining risks: override maintenance, known unused Prisma in-place aliasing and future upload limits/error mappings; authorized CREATE orchestration and explicit reader/worker ownership, external-state races, reschedule/cancel and SENDING recovery, and acceptance. No new migration, real data, external sends, provider/secrets/IAM/billing configuration, charges, merge, deployment or activation. Estimates remain APP-013 ~85%; governed APP-006 through APP-016 ~81%, planning only. Stop review-ready.
- Exact commands, compatibility limits and audit snapshot: `evidence/APP-013/readiness-report.md` and `google-uuid-audit-summary.json`.

### Earlier: Scoped Prisma merge-dependency remediation

- Owner requested continued fixing; fetched/reconciled backend `ace10ff` / governance `1c68cc9`, APP-013 sole Now. Explicitly selected one bounded Prisma merge-dependency section on existing focused branches; unrelated saved changes preserved.
- Scoped `@prisma/config@7.10.0 -> deepmerge-ts: 8.0.2` override replaces 7.1.5; exactly one lock entry changes. This is an intentional major library exception, not a Prisma upgrade. Prisma/client/adapter, Nest/Express, prior overrides, runtime application source, UI, schema and other resolutions remain unchanged.
- Before update, two tiny same-path self-referencing objects reproduced the installed 7.1.5 deepmerge RangeError. Twelve new native tests, automatically wrapped by Jest, verify patched cycles, actual Prisma consumer/module resolution, ordinary records/arrays and non-mutating merge behavior, changed Map semantics, known in-place aliasing limits, real CJS/ESM config loading/path/datasource preservation, invalid config rejection and missing-config refusal. Synthetic objects/config files only; no DB connection or seed execution in these fixtures.
- Clean install, backend lint/build, 54 suites/614 tests (3 existing skipped tests), architecture/Prisma and disposable 15-migration suite pass, including 11 prior actual process-crash cases. Zero real provider calls; fixture database dropped and absence independently verified.
- UI unchanged: lint/type check, 60 tests, 14-page build and five desktop/390px browser harnesses pass: 22 framework route checks/12 home navigations/static manifest; customer/dispatch, technician, policy and notifications 14/14/8/92 mocked requests. Zero external requests/page errors; temporary missing-link mobile and notification desktop screenshots visually reviewed.
- Backend full/omit-dev audits improve 4 high/8 moderate -> 0 high/8 moderate; deepmerge-ts and related Prisma findings are absent. UI full/omit-dev remain zero. High-severity gate now passes, but full backend audit still fails on Firebase/Google/uuid and remains unaccepted. Counts describe affected packages/current advisory metadata, not unique vulnerabilities or a comprehensive security guarantee.
- APP-013 owns this exact-parent override. Re-review on any Prisma/config change; remove when native resolution is patched and cycle/config/PostgreSQL/application/browser gates pass. Tests assert the inspected loader imports ordinary deepmerge as c12's merger, not deepmergeInto or unsafe entrypoints. Config uses plain records/strings, not custom merge callbacks or Map values.
- An exploratory in-place immutability test failed: deepmergeInto can preserve source aliases and a later in-place merge can mutate them. Retained an explicit aliasing limitation test and passing ordinary-deepmerge immutability test. The inspected Prisma path does not use that API; no blanket mutation-safety claim. v8 Map merging and custom type changes are documented, not assumed backward-compatible.
- Remaining risks: Firebase/Google/uuid dependencies; override maintenance and future upload limits/error mappings; authorized CREATE orchestration/recovery ownership, external-state races, reschedule/cancel and SENDING recovery, and acceptance. No schema/new migration, real data, external sends, provider/secrets/IAM/billing configuration, charges, merge, deployment or activation. Estimates unchanged APP-013 ~85%; governed APP-006 through APP-016 ~81%, planning only. Stop review-ready.
- Exact commands, limitations and override retirement: `evidence/APP-013/readiness-report.md`; audit snapshot: `evidence/APP-013/prisma-merge-audit-summary.json`.

### Earlier: Scoped Nest/Multer dependency remediation

- Owner continued the recommended Multer/Nest checkpoint; fetched/reconciled backend `54b613f` / governance `ed21a09`, APP-013 sole Now. Completed only this bounded dependency section on existing focused branches; unrelated saved changes preserved.
- Scoped `@nestjs/platform-express@^11.2.3 -> multer: 2.3.0` override replaces the 2.2.0 pin. Exactly one lock entry changes. Nest/Express, Prisma/client/adapter, prior mysql2/PostCSS overrides, application source, UI, schema and all other resolutions are unchanged; no major framework upgrade or forced audit fix.
- Twelve native checks run automatically through one new Jest wrapper: reviewed Nest consumer/lock resolution; ordinary field compatibility; explicit array-index bounds; invalid sparse append routed to callback; async file-size rejection across single/array/fields/any; exact-limit acceptance; real diskStorage stream error, descriptor close and partial-file unlink; Nest success/413/400 compatibility; and the new array-index error's missing HTTP mapping. Synthetic streams/files only, no sockets or upload endpoint.
- Clean install, backend lint/build, 53 suites/613 tests (3 existing skipped tests), architecture/Prisma and disposable 15-migration suite pass, including 11 prior actual process-crash cases. Zero real provider calls; fixture database dropped and absence independently verified.
- UI unchanged: lint/type check, 60 tests, 14-page build and five desktop/390px browser harnesses pass: 22 framework route checks/12 home navigations/static manifest; customer/dispatch, technician, policy and notifications 14/14/8/92 mocked requests. Zero external requests/page errors. Temporary missing-link mobile and notification desktop screenshots visually reviewed.
- Backend full audit improves 9 high/8 moderate -> 4 high/8 moderate; final omit-dev also 4 high/8 moderate. Multer and its related Nest findings are absent. UI full/omit-dev remain zero, critical-only gate passes. Remaining full backend audit failure is unaccepted and blocks ticket/security acceptance; these are affected-package counts, not unique vulnerabilities or deployed fixes.
- APP-013 owns the temporary override. Re-review on every Nest change; the test intentionally requires Nest platform-express 11.2.3. Remove when native resolution is patched and multipart/application/browser gates pass. Prior override retirement conditions remain intact.
- No multipart handlers were found in application source. Future uploads remain gated on explicit array-index/size/count/depth limits and HTTP mappings for new Multer errors: Nest 11 leaves LIMIT_FIELD_ARRAY_INDEX as a plain Error rather than a mapped 4xx. Array-index protection is opt-in, not guaranteed by the version alone. No upload route, global middleware or upload configuration is enabled.
- Remaining risks: Prisma/deepmerge-ts and Firebase/Google/uuid; authorized CREATE orchestration/recovery ownership, external-state races, reschedule/cancel and SENDING recovery, and remaining acceptance. No schema/new migration, real data, external sends, provider/secrets/IAM/billing configuration, charges, merge, deployment or activation. Estimates unchanged APP-013 ~85%; governed APP-006 through APP-016 ~81%, planning only. Stop review-ready.
- Exact review commands and limits: `evidence/APP-013/readiness-report.md`; objective audit snapshot: `evidence/APP-013/multer-audit-summary.json`.

### Earlier: Scoped Prisma/mysql2 dependency remediation

- Owner requested continued risk remediation; fetched/reconciled backend `9eb43e5` / governance `dc1d318`, APP-013 sole Now. Explicitly selected one bounded Prisma/mysql2 compatibility section on existing focused branches; unrelated saved-checkout changes preserved.
- Scoped `prisma@^7.10.0 -> mysql2: 3.24.4` override replaces Prisma 7.10.0's 3.15.3 pin. Exactly six lock entries change: mysql2 and required lru.min update, sql-escaper added, superseded sqlstring/denque/seq-queue removed. Prisma/client/adapter versions, PostgreSQL schema, application source, UI and all other resolutions remain unchanged; no broad audit fix or major downgrade.
- Ten native Node protocol tests, automatically wrapped by Jest, verify installed/locked resolution, default cleartext-auth refusal before writes, explicit opt-in compatibility, prototype-name refusal, valid/malformed packets, synchronous/asynchronous inflate size bounds and async/uncompressed ordering, plus public SQL formatting. Fixtures are in-memory, at most 18 KB, with fictional data; no sockets, real credentials or MySQL server. No old-version negative reproduction or live MySQL/Studio acceptance claimed.
- Clean install, backend lint/build, 52 suites/612 tests (3 existing skipped tests), architecture/Prisma and disposable 15-migration suite pass, including 11 prior actual process-crash cases. Zero real provider calls; fixture database dropped and absence independently verified.
- UI unchanged: lint/type check, 60 tests, 14-page build and all five desktop/390px browser harnesses pass: 22 framework route checks/12 home navigations/static manifest and 14/14/8/92 mocked requests. Zero external requests/page errors; temporary missing-link mobile and notification desktop screenshots visually reviewed.
- mysql2 is absent from post-update audits. Fresh pre-change full audit was already 9 high/8 moderate due newly reported Multer/Nest findings, superseding the previous checkpoint's 4 high/8 moderate. Post-install audit was 8 high/8 moderate; final post-validation full audit is 9 high/8 moderate, omit-dev 8 high/8 moderate, with existing deepmerge risk also propagated to @prisma/client's optional Prisma peer. Counts/metadata changed during this run: no net overall count-reduction claim. UI full/omit-dev remain zero, critical-only backend gate passes; full backend findings remain unaccepted.
- APP-013 owns this temporary override. Re-review at the next Prisma change; the test intentionally requires current Prisma 7.10.0. Remove only when native resolution selects a reviewed patched mysql2 and protocol/PostgreSQL/application/browser gates pass. Explicit cleartext opt-in and custom/legacy plugin escapes remain possible; this patch is not universal TLS enforcement. No such configuration is enabled.
- Remaining risks: Multer/Nest, Prisma/deepmerge-ts and Firebase/Google/uuid; authorized CREATE orchestration/recovery ownership, external-state races, reschedule/cancel and SENDING recovery, and acceptance. No multipart handlers were found in application source, but that is not complete reachability proof or risk acceptance.
- No schema/new migration, real data, external sends, provider/secrets/IAM/billing configuration, charges, merge, deployment or activation. Estimates unchanged APP-013 ~85%; governed APP-006 through APP-016 ~81%, planning only. Stop review-ready; no automatic ticket transition.
- Exact review commands, sources and audit timing: `evidence/APP-013/readiness-report.md`; objective evidence: `evidence/APP-013/mysql2-audit-summary.json`.

### Earlier: Backend lint-tool dependency remediation

- Owner requested continued remediation; fetched/reconciled backend `d12ba7c` / governance `494e908`, APP-013 sole Now. Explicitly selected one bounded backend lint-tool dependency section on existing focused branches; unrelated saved-checkout changes preserved.
- Backend lock changes exactly four dev-only entries: @humanfs/node 0.16.7 -> 0.16.8, required @humanfs/core 0.19.1 -> 0.19.2, added @humanfs/types 0.15.0, and brace-expansion 1.1.12 -> 1.1.18. Existing dependency ranges, manifests, runtime application source, UI and all other resolutions are unchanged. No override, forced audit fix or SDK downgrade.
- Clean install and five native Node tests verify reviewed resolution/lock agreement, direct file symlink and contained file/directory symlink preservation, ordinary copying and bounded ESLint brace/minimatch compatibility. A new Jest wrapper runs them automatically. Synthetic temporary files only; no old-version negative reproduction, top-level directory-symlink/race proof, large-input stress test or blanket path-containment claim.
- Backend lint/build, 51 suites/611 tests (3 existing skipped tests), architecture/Prisma and disposable 15-migration suite pass, including 11 prior actual process-crash cases. Zero real provider calls; fixture database dropped and absence independently verified.
- UI unchanged: lint/type check, 60 tests and 14-page build pass. All five desktop/390px browser harnesses pass: framework 22 route checks/12 home navigations/static manifest; customer/dispatch, technician, policy and notifications 14/14/8/92 mocked requests. Zero external requests/page errors; temporary missing-link mobile and notification desktop screenshots visually reviewed.
- Backend full audit improves 5 high/9 moderate -> 4 high/8 moderate (14 -> 12 affected packages); omit-dev remains 4 high/8 moderate. UI full/omit-dev audits remain zero. Zero critical; critical-only gate passes, but remaining backend findings are unaccepted and full audits still fail. Audit counts are affected packages, not unique vulnerabilities or verified public exploits.
- Remaining dependency work is Prisma/deepmerge-ts/mysql2 and Firebase/Google/uuid. Current audit suggests major downgrades to prisma 6.19.3 and firebase-admin 10.3.0; neither is applied. These require separately scoped compatibility work. Calendar authorized CREATE orchestration/recovery ownership, external-state races, reschedule/cancel and SENDING recovery and acceptance remain open.
- No schema/new migration, real data, external sends, provider/secrets/IAM/billing configuration, charges, merge, deployment or activation. Estimates unchanged APP-013 ~85%; governed APP-006 through APP-016 ~81%, planning only. Stop review-ready; no automatic ticket transition.
- Exact commands, source discrepancy and boundaries: `evidence/APP-013/readiness-report.md`; objective audit snapshot: `evidence/APP-013/backend-toolchain-audit-summary.json`.

### Earlier: UI development-tool dependency remediation

- Owner requested continued risk remediation; fetched/reconciled backend `6c467a1` / governance `ddd92e4`, APP-013 sole Now. Explicitly selected one bounded UI development-tool dependency section. Existing focused branches only; unrelated saved-checkout edits preserved.
- Updated only eight UI lockfile entries across six dependency families within existing major versions: ajv 6.15.0, brace-expansion 1.1.18/2.1.4, flatted 3.4.4, js-yaml 4.3.2, minimatch 3.1.5/9.0.9 and picomatch 4.0.7. All eight entries are dev dependencies. Manifest, Next/React, PostCSS override, other package resolutions, backend dependencies and application source are unchanged; no forced audit fix.
- Clean npm ci and 16 new tests verify all eight installed copies through actual toolchain consumers and lockfile agreement, Ajv validation, YAML aliases/round-trip, cyclic cache serialization, flatted prototype-reference refusal, both brace/minimatch generations, file discovery and an ESLint negative control. No dangerous large-input performance payload or real-data exploit tested.
- UI lint/type check, 60 tests and 14-page build pass. All five desktop/390px browser harnesses pass: framework 22 route checks/12 home navigations/static manifest; customer/dispatch, technician, policy and notifications 14/14/8/92 mocked requests, zero external requests/page errors. Temporary screenshots preserve committed evidence; missing-link mobile and notification desktop visually reviewed.
- Backend lint/build, 50 suites/610 tests (3 existing skips), architecture/Prisma and disposable 15-migration suite pass, including 11 prior actual process-crash cases. Zero real provider calls; fixture database dropped and absence independently verified.
- UI full audit improves 5 high/1 moderate -> zero findings, exit 0; omit-dev remains zero. Backend unchanged 5 high/9 moderate, omit-dev 4 high/8 moderate; critical-only gate passes with zero critical. Backend findings remain unaccepted. A clean UI audit is current advisory-database evidence, not an overall security guarantee or deployed remediation.
- No schema/new migration, real data, external sends, provider/secrets/IAM/billing configuration, charges, merge, deployment or activation. Calendar orchestration/recovery ownership, external-state races, reschedule/cancel and SENDING recovery, backend dependency remediation and remaining acceptance stay open. Planning estimates unchanged APP-013 ~85%; governed APP-006 through APP-016 ~81%, not release readiness.
- Exact scope, warnings, commands and sources: `evidence/APP-013/readiness-report.md`; audit snapshot: `toolchain-audit-summary.json`.

### Earlier: PostCSS security remediation

- Owner requested continued risk remediation; fetched/reconciled backend `5ac324c` / governance `430daf6`, APP-013 sole Now. Explicitly selected one bounded PostCSS security section. Existing focused branches only; unrelated saved-checkout edits preserved.
- UI manifest adds only `next@15.5.25 -> postcss: 8.5.28` override; lockfile changes only PostCSS 8.4.31 -> 8.5.28 and its dependency-range metadata. Next/React, other resolved packages, backend dependencies and application source are unchanged. Clean npm ci and resolution through Next's actual CSS build consumer verified the installed patch.
- Eight new tests cover exact override/installed/lock agreement, three source-map disclosure boundaries, adjacent/inline/explicit-map compatibility, plugin transformation and closing-style serialization escaping. The three disclosure cases first failed on 8.4.31 with small synthetic files, then passed on 8.5.28. No real secrets/customer files or live endpoint tested; library reproduction is not proof of an exploitable CallDesk route.
- UI lint/type check, 44 tests and 14-page build pass. All five desktop/390px browser harnesses pass: framework smoke 22 route checks/12 home navigations/static manifest; customer/dispatch, technician, policy and notifications 14/14/8/92 mocked requests. Zero external requests/page errors. Temporary screenshots preserve committed evidence; missing-link mobile and notification desktop visually reviewed.
- Backend lint/build, 50 suites/610 tests (3 existing skips), architecture/Prisma and disposable 15-migration suite pass, including 11 prior process-crash cases. Zero real provider calls; fixture database dropped and absence independently verified.
- UI full audit improves 6 high/2 moderate -> 5 high/1 moderate (8 -> 6 affected packages); PostCSS and Next findings absent. UI omit-dev now zero findings, exit 0. Backend unchanged 5 high/9 moderate; omit-dev 4 high/8 moderate. Both critical-only gates pass; remaining full-audit findings are not accepted.
- Override ownership/removal stays in APP-013: re-review on the next framework update; remove only when Next natively resolves a reviewed patched PostCSS version and these tests/build/browser gates pass. This exact-version exception is not a permanent global override or permission for another major upgrade.
- No schema/new migration, real data, external sends, provider/secrets/IAM/billing configuration, charges, merge, deployment or activation. Functional Calendar/unknown-send recovery and acceptance remain open. Planning estimates unchanged APP-013 ~85%; governed APP-006 through APP-016 ~81%, not release readiness.
- Exact review commands, source links and scope: `evidence/APP-013/readiness-report.md`; objective snapshot: `postcss-audit-summary.json`.

### Earlier: UI framework security upgrade

- Owner requested continued risk resolution; fetched/reconciled backend `1955200` / governance `e095321`, APP-013 sole Now. Explicitly selected one bounded UI framework security upgrade within the approved risk plan. Existing focused branches only; unrelated saved-checkout edits preserved.
- Next/eslint-config-next 14.2.33 -> 15.5.25; React/React DOM 18.3.1 -> 19.2.8 with aligned React 19 types. Clean install and installed/manifest/lock agreement verified. Chose the patched 15 maintenance line to limit this checkpoint to one Next major upgrade; no forced dependency overrides or backend dependency changes.
- Preserved static `ui/out` hosting. Manifest explicitly uses force-static; six home anchors use Next Link with prefetch disabled to satisfy the newer lint rule. Browser verifies navigation. No API, auth, payment, Calendar, SMS or provider behavior changed.
- UI lint/type check/14-page build and 36 tests pass. New desktop/390px browser smoke passes 22 route checks, 12 home navigations, missing-link fail-closed states, payment return copy and static manifest; zero external requests, console/page errors or failed resources. Existing customer/dispatch, technician, policy and notification regressions pass (14/14/8/92 mocked requests). New missing-link screenshots visually reviewed.
- Backend lint/build, 50 suites/610 tests (3 existing skips), architecture/Prisma and disposable 15-migration suite pass, including 11 prior real process-crash cases. Zero real provider calls; fixture database dropped and absence verified.
- Fresh UI audit before this change was 1 critical/9 high/1 moderate, superseding the previous checkpoint snapshot. After: 0 critical/6 high/2 moderate (11 -> 8 affected packages). Omit-dev: 1 high/1 moderate via PostCSS/Next. Backend unchanged 5 high/9 moderate; omit-dev 4 high/8 moderate. Both critical-only commands pass; full audits fail and remaining findings are unaccepted.
- No schema/new migration, real data, external messages, provider/secrets/IAM/billing configuration, charges, merge, deployment or executor/worker activation. Branch-only remediation, not a deployed fix. APP-013 ~85%; governed APP-006 through APP-016 ~81%, planning only. Authorized CREATE orchestration/recovery ownership, external-state races, reschedule/cancel and SENDING recovery, remaining dependency debt and acceptance stay open.
- Critical GHSA-p293-qw3h-jr36 is removed from the audit; its Windows Next-server condition does not match the checked-in static hosting architecture, but deployed exposure was not tested. Exact scope, source links, audit artifact and commands: `evidence/APP-013/readiness-report.md` and `framework-audit-summary.json`.

### Earlier: qs dependency remediation

- Owner requested continued risk remediation; fetched/reconciled backend `bcee134` / governance `1b2061b`, APP-013 sole Now. Explicitly selected and announced one narrow compatible dependency fix from the approved risk plan before returning to functional orchestration. Existing focused branches only; unrelated saved edits preserved.
- Only backend lockfile qs changes 6.15.3 -> 6.16.0. No manifest/override/framework/provider SDK/UI dependency or runtime application code changed. Small bounded old-version fixtures reproduced the two maintainer-reported defects; clean install and 12 new tests verify patched consumer resolution, limits, serialization and Nest raw-body/form compatibility.
- Runtime package presence verified, but no complete exploitable CallDesk path established. Not a confirmed production exploit or live remediation claim.
- Passed backend lint/build, 50 suites/610 tests (3 existing skips), architecture/Prisma; disposable 15-migration suite and prior 11 crash cases with zero real provider calls; database dropped/absence verified. UI lint/30 tests/14-page build and existing desktop/390px synthetic browser regressions pass.
- Full backend audit improved 5 high/10 moderate -> 5 high/9 moderate; qs advisories removed. Omit-dev still 4 high/8 moderate. UI unchanged 10 high/1 moderate. Zero critical; remaining findings unaccepted.
- No migration outside local fixtures, schema, provider/secrets/IAM/billing, real data, merge, deploy or activation. Functional recovery risks remain; authorized CREATE orchestration is still pending. Estimates unchanged APP-013 ~85%, governed APP-006 through APP-016 ~81%, planning only. Review commands and limits: `evidence/APP-013/readiness-report.md`; audit snapshot: `evidence/APP-013/qs-audit-summary.json`.

### Earlier: policy-update Calendar guards

- Owner approved the remaining-risk plan and item 1; fetched/reconciled backend `a048d3e` / governance `7f58671`, APP-013 sole Now. Completed only urgency/payment-exception job-policy guards; original saved changes preserved.
- Unfinished Calendar work blocks urgency replay/override and payment exception approve/revoke. Both use tenant/job/deletion/version/no-unfinished conditional writes and monotonic updatedAt; payment retains client expected version and current status. Winning policy JSON and atomic audits are preserved.
- Existing financial rules, verified-payment handling, Checkout/webhooks, entitlements and operations escalation remain unchanged. Urgency API retains server-observed concurrency control, not a new client-version field. No Stripe/provider/SDK/configuration action.
- Passed backend lint/build, 49 suites/598 tests (3 existing skips), architecture/Prisma; local 15-migration fixture covers 12 action/status holds, both race orders, competing policy snapshots, tenant/deletion boundaries and audit rollback. Prior 11 process crashes pass; zero real provider calls; test database removed and absence verified.
- UI code unchanged: lint/30 tests/14-page build; new desktop/390px urgency conflict QA (8 requests, 4 synthetic POSTs), visually reviewed screenshots and prior 14/14/92-request regressions pass.
- Full audits still unaccepted: backend 5 high/10 moderate, UI 10 high/1 moderate, 0 critical. No dependency/schema changes, migration outside disposable test DB, real data, merge, deploy or activation.
- Review-ready: APP-013 ~85%; governed APP-006 through APP-016 ~81%, planning only. Next after review is one bounded authorized CREATE orchestration section with upstream guards and explicit reader/worker ownership; activation stays gated. Other payment/entitlement state, post-preflight/provider races, reschedule/cancel and SENDING recovery, dependencies and remaining messaging/acceptance stay open. Exact commands: `evidence/APP-013/readiness-report.md`.

### Earlier: lifecycle and technician Calendar mutation guards

- Owner reviewed inactive CREATE execution and said proceed; fetched/reconciled backend `df9143a` / governance `abed80c`, APP-013 sole Now. Completed only lifecycle/technician guards on existing focused branches; unrelated saved changes preserved.
- Unfinished Calendar work rejects completion and all six technician actions before replay/write. Exact-version/current-state/no-unfinished claims and monotonic updatedAt protect both mutation paths. Tenant, assignee, transactional audit, departure intent and payment semantics remain intact.
- Technician API exposes only calendarSyncPending; held cancellations remain visible, actions hidden, provisional/no-travel notice shown, stale detail cleared after 409. Desktop/390px screenshots visually reviewed.
- Passed backend lint/build, 49 suites/588 tests (3 existing skips), architecture/Prisma; disposable 15-migration fixture including 12 action/status combinations, both deterministic read/update races, opposite-order stale reservations and rollback; prior 11 actual crash cases pass. UI lint/30 tests/14-page build; new 14-request synthetic browser test plus existing regressions. Zero real provider calls; local database dropped and absence verified.
- Critical audits pass with zero critical; backend 5 high/10 moderate and UI 10 high/1 moderate remain unaccepted. No dependencies/schema/configuration/financial policy changes or executor activation.
- Legacy unjournaled scheduling, policy-version coordination, reader/worker ownership, post-preflight/provider races, reschedule/cancel reconciliation and SENDING crash risks remain. No migration, real data, provider/secrets/IAM/billing, merge or deployment.
- Stop review-ready: APP-013 ~83%; governed APP-006 through APP-016 ~81%, planning only. Review evidence and guards before scoping authorized orchestration with remaining policy/ownership protections; no activation alone.

### Earlier: inactive one-shot CREATE execution

- Owner reviewed consumer guards and said proceed; fetched/reconciled backend `3c159b9` / governance `abac6af`, APP-013 sole Now. Added only the internal persisted-reservation executor/creator seam and proof; original saved changes preserved.
- PENDING -> UNCERTAIN attempt latch and exact unassigned job-version advance commit before one saved-ID/operation-marker insert. Concurrent callers/restarts never reinsert. Unknown DB acknowledgment never dispatches. Newer observed job/review changes hold; only matching read-back atomically finalizes journal/job/intent/audit. No compensation or direct message.
- Narrow Google adapter uses one encoded POST, no raw response/logging/customer content/attendees, eight-second HTTP timeout and no redirect/retry. No module/controller/worker registration or scheduling public-flow replacement.
- Passed backend lint/build, 49 suites/570 tests (3 existing skips), architecture/Prisma; disposable 15-migration suite with two new process exits (11 total), concurrent single attempt, lost acknowledgments and read-only recovery. UI unchanged: lint/29 tests/build and 14-request/92-request desktop/390px synthetic browser regressions passed. Zero provider calls; fixture removed.
- Source audit found technician actions lack journal predicates, completion lacks exact version/journal guard, and urgency/payment-policy updates need coordination. Existing post-check/provider and SENDING crash gaps remain. No deployment/schema/migration/financial/provider/configuration action; prior migration/retention and complete activation protocol remain gated. Dependencies unchanged: backend 5 high/10 moderate, UI 10 high/1 moderate, 0 critical; pg warning remains.
- Review this section, then one bounded lifecycle/technician mutation-guard section preserving financial semantics, followed by authorized scheduling orchestration and recovery ownership/retry/review controls. APP-013 ~81%; governed APP-006 through APP-016 ~80%, planning only. Full audit and exact commands: `evidence/APP-013/readiness-report.md`. Stop review-ready.

### Earlier: unfinished Calendar consumer guards

- Owner reviewed CREATE read-back checkpoint and said proceed; fetched/reconciled backend `f30760a` / governance `b2dcec5`. APP-013 remains sole Now; original saved-checkout changes preserved.
- Existence-only unfinished-journal guards now hold signed customer views/actions, initial confirmation, dispatch eligibility/assignment changes and notification admission/delivery. Customer HTTP 409 hides provisional details and clears stale cards; dispatch uses explicit ESCALATED/provisional hold and no override. Conditional tenant/version/no-unfinished writes protect customer audit and legacy scheduling/dispatch mutations.
- Pending notifications wait 60 seconds without consuming enqueue/delivery retries or becoming stale solely due to the unfinished operation. Delivery hold happens before decrypt/provider access and cannot release another claim. Current-state hashes, consent, deduplication and unknown-send safety remain.
- Passed backend lint/build, 47 suites/535 tests (3 existing skips), architecture/Prisma and 15-migration disposable local proof including 12 new action/status guard combinations plus prior nine process crashes. UI lint/29 tests/static build, 14-request new desktop/390px guard QA and 92-request notification regression passed; four new screenshots inspected. Zero provider calls, fixture removed.
- Existing pg warning and backend 5 high/10 moderate, UI 10 high/1 moderate audit risks remain; 0 critical. Consumer queries require the previously gated journal migration. No new schema/dependency/module registration or external/release action. Journal writer/reconciler/worker remain inactive; legacy unjournaled crashes, post-check provider races and SENDING crash recovery are not solved here.
- Review this section, then separately scope guarded CREATE integration, including competing technician/job entry points, before bounded recovery-worker/review controls. No new ticket, live activation, deployment or migration authorization. Planning estimates APP-013 ~79%, governed APP-006 through APP-016 ~80%. Exact review commands and risks: `evidence/APP-013/readiness-report.md`.

### Earlier: inactive CREATE Calendar read-back reconciliation

- Owner reviewed journal foundation and said proceed. Fetched/reconciled backend `cbdddc9` / governance `c0f47d8`; APP-013 remains sole Now. Added only the journal-to-read-back-to-local-finalization section, with no SchedulingModule/route/worker registration.
- Read-only Google Calendar adapter uses the saved encoded target and returns allowlisted evidence. CREATE reconciler verifies tenant/job/operation markers, event ID, confirmed single blocking event, exact future window and current local claim version. Missing/conflicting/past-window evidence stays held for review; unavailable reads/persistence stay pending. No blind recreate, rollback, legacy adoption or Calendar write.
- Matching read-back atomically finalizes journal/job/confirmation intent/system audit; only a hash of ETag is audited. Concurrent/late reads cannot overwrite a newer completion/review decision. Lost commit acknowledgment recognizes the receipt without duplicate audit/intent. No immediate queue/send/notifier.
- Passed backend lint/build, 46 suites/510 tests (3 existing skips), architecture/Prisma; UI lint/29 tests/static build and 92-request desktop/390px synthetic QA, four screenshots inspected. Disposable local proof passed 15 existing migrations, three new actual process-exit cases plus six earlier ones, actual post-write rollback, replay/concurrency/late-response/ack-loss/newer-edit controls. Fixture removed and absence verified; provider calls zero. Initial test typing/stale-build failures corrected before full clean sequence.
- Existing pg warning and audit risks remain: backend 5 high/10 moderate, UI 10 high/1 moderate, 0 critical. No dependency/schema/migration change or release/provider/real-data action. Journal migration/retention and live activation remain separately gated. Planning estimates APP-013 ~77%, governed APP-006 through APP-016 ~80%.
- Next after review: one bounded consumer pending-state guard section covering customer views/actions, dispatch eligibility and notification admission/delivery, before stable-ID/operation-marker CREATE integration or recovery worker activation. Existing live Calendar ambiguity/crash gaps remain open. Full evidence/review commands: `evidence/APP-013/readiness-report.md`. Stop review-ready.

### Earlier: Calendar operation journal foundation

- Owner approved the robust Calendar/crash-recovery recommendation. Resumed fetched backend `f7d5e1e` / governance `82fc1fb`; APP-013 remains sole Now. Added only the local journal/reservation persistence foundation and tests, with no production consumer or SchedulingModule registration.
- Atomic version-bound CREATE/RESCHEDULE/CANCEL reservation plus PENDING journal; stable create event identity, retained original deletion target/window/label, tenant composite FK, one unfinished operation per job and SQL invariants. Hard deletion of referenced jobs/tenants is restricted pending an explicit archival policy. No external call, successful-appointment audit, SMS intent, worker or completion transition is added.
- Local proof passed 15 migrations and six actual process exits before/after commit, concurrent claims, real post-insert rollback, restart persistence, tenant/version/deletion/SQL guards and no premature messages. Fixture removed, absence verified; zero provider calls. Backend lint/build, 464 tests (3 existing skips), architecture/Prisma; UI lint/29 tests/static build and 92-request desktop/390px synthetic browser QA passed; four screenshots inspected. Initial concurrent full-test process exit 139 did not recur on two full reruns; root cause unestablished. Existing pg warning and backend 5 high/10 moderate, UI 10 high/1 moderate audits remain open.
- This is NOT live crash recovery: existing scheduling, finalization and UI paths remain unchanged. Next after review: journal-aware scheduling integration and bounded reconciliation with provider read/version checks, recovery ownership and atomic journal/appointment/audit/intent finalization. Preserve all existing auth/payment/availability guards. Do not activate this journal alone.
- Migration `20260908180000_add_calendar_operation_journal` is disposable-local-tested only. No staging/production, real data, provider/configuration, billing/secrets/IAM, merge/deploy or dependency changes. APP-013 approximately 75%; APP-006 through APP-016 approximately 80%, planning estimates. Exact validation/review steps and browser limits: `evidence/APP-013/readiness-report.md`. Stop review-ready.

### Earlier: post-Calendar reschedule intent finalization

- Owner reviewed cancellation finalization and said proceed. Fetched/reconciled backend `df97aa8` / governance `50c3db7`; APP-013 remains sole Now. Completed reschedule finalization only on the existing focused branches, preserving original saved-checkout changes.
- Added `AppointmentReschedulingService`: original version/tenant/window-bound reservation claim, exact-version pre-acknowledgment compensation, and post-Calendar finalization that atomically advances the job version, captures `APPOINTMENT_RESCHEDULED` intent and records customer activity audit. Existing labels are preserved; intent ID and exact finalized timestamp are additive audit metadata. Claim/finalization/compensation advance versions even within one clock millisecond.
- Same-window replay requires an audit matching the current job version, not merely the local window. Pending, legacy or subsequently edited snapshots require office review; finalized replay creates nothing. This deliberately conservative check can require review after an unrelated job edit. Finalization failure after Calendar acknowledgment does not roll back the new Calendar/local window; post-commit worker/operations/logging failure cannot undo success. Removed SchedulingService's obsolete direct messaging dependency/helper.
- All four current intent templates (confirmation/reschedule/cancellation/technician departure) use existing disabled-by-default processing and owner/admin reviewed retry with unchanged state/hash/identity/consent/quiet-hour safeguards. UI copy and synthetic fixture now include rescheduling; no historical backfill.
- Passed backend lint/build, 43 suites/443 tests (1 suite/3 existing skips), architecture/Prisma; UI lint, 29 tests/build; desktop/390px synthetic browser QA, 92 mocked requests (14 POSTs). Disposable local PostgreSQL proof passed all 14 existing migrations plus real reschedule ordering, rollback, concurrency, replay/version/tenant, compensation and worker/retry checks, zero provider calls; fixture removed and absence verified. Initial test/formatting failures corrected before clean run.
- Calendar/database atomicity, global serialization of external operations, pre-finalization crashes and unknown external outcomes remain manual reconciliation gaps. Local customer view is not independent Calendar proof; no absent-intent recovery or backfill. No new schema/migration/dependencies/provider/configuration, live sends, real data, merge or deployment. Prior intent migration/live acceptance remain gated.
- Audit remains 0 critical; backend 5 high/10 moderate, UI 10 high/1 moderate. Dependency release triage remains open; existing local pg warning. Planning estimate APP-013 74%; governed APP-006 through APP-016 80%. Remaining calendar reconciliation, other events/templates/preferences/technician notifications/email and owner/live acceptance. Exact steps and screenshots in APP-013 evidence; stop review-ready.

### Earlier: post-Calendar cancellation intent finalization

- Owner reviewed the guarded retry UI and said proceed. Both remotes matched backend `9a3d86a` / governance `252f340`; APP-013 remains sole Now. Completed cancellation notification finalization only, not rescheduling, calendar reconciliation or release.
- Added `AppointmentCancellationService`: version/tenant/deletion-bound cancellation claim, version-bound calendar-error compensation, and post-acknowledgment finalization that atomically advances the local version, captures the canonical cancellation SMS intent and records `appointment.customer_cancelled` CUSTOMER audit. Intent/audit/commit failure after acknowledged Calendar deletion never restores an active appointment; it returns office-review-required. Finalized replay requires the local audit and creates nothing; legacy/in-flight/unfinalized cancellation replay fails closed.
- Post-commit worker, operations-notification and logging failures cannot undo cancellation. Cancellation joins existing disabled-by-default intent processing and owner/admin reviewed retry using unchanged state/hash/consent/quiet-hour/queue identity safeguards. Notification-center copy and synthetic fixtures now cover cancellation; reschedule capture/backfill remain absent.
- Passed backend lint/build, 42 suites/425 tests (1 suite/3 existing skips), architecture/Prisma; UI lint, 29 tests/build; synthetic desktop/390px QA (92 mocked requests, 14 POSTs) with four inspected cancellation screenshots. Disposable local PostgreSQL proof passed 14 existing migrations and real cancellation ordering/atomicity/rollback/concurrency/replay/recovery/compensation guards with zero provider calls; fixture removed and absence verified. Initial test typing/formatting lint errors were corrected.
- Explicit gap: the cancellation claim still precedes Calendar deletion. Calendar/database cross-system atomicity, unknown deletion outcomes and crashes before finalization are not solved. Earlier calendar-error compensation remains but is version-bound, and the error no longer promises the event still exists. Existing view status reflects local state, not independent Calendar verification. No historical backfill or repair control.
- Audit: 0 critical; backend 5 high/10 moderate, UI 10 high/1 moderate; unchanged dependency/lockfiles, release triage remains open. No new schema/migration, provider/configuration, merge/deploy, live messages or real customer/appointment actions. Prior intent migration remains release-gated.
- Planning estimates APP-013 roughly 71%; governed APP-006 through APP-016 roughly 79%. Remaining reschedule durability, calendar reconciliation, other events/templates/preferences/technician notifications/email and owner/live acceptance. Exact review steps in APP-013 evidence; stop review-ready.

### Earlier: guarded owner/admin exhausted-intent retry UI

- Owner reviewed the retry API and said proceed. Resumed clean focused backend `aab434b` and governance `5f3127a`; canonical pointer and handoffs still name APP-013 as sole Now. Completed only the notification-center retry review section on the existing feature branches; original saved-checkout changes remain untouched.
- New private/no-store capability read derives owner/admin permission from verified claims using the same policy as the POST guard. Dispatcher stays read-only; failed/late capability reads cannot grant access. Review requires a supported FAILED/five-attempt/unlinked snapshot, explicit fixed reason and acknowledgment. POST sends the exact listed timestamp; the existing server state/tenant/audit/concurrency checks remain authoritative.
- One in-flight submission per page, 15-second request timeout, no automatic retry, and snapshot clearing after every submission. Success means pending only; ambiguous outcomes warn that the server may already have accepted. All outcomes require manual reload before another review. Token/job/session edits suppress late responses without claiming to cancel an accepted request.
- Backend lint/build, 411 tests (3 existing skips), architecture/Prisma passed; UI lint, 29 tests/build passed. Synthetic Chrome desktop/390px QA covers access, review/acknowledgment, duplicate clicks, rejected/uncertain requests and late-response clearing. Disposable local database proof passed all 14 existing migrations and recovery invariants with zero provider calls; fixture removed and absence verified. See current evidence for exact QA counts and commands.
- No schema/dependency/provider/configuration, merge/deploy or real-data changes. Critical audit gates pass; current dependency counts and pre-existing tool warnings are recorded in evidence, not treated as release acceptance. Prior intent migration remains release-gated.
- Remaining owner/live acceptance, reschedule/cancellation durability, calendar reconciliation, events/templates/preferences/technician notifications/email. Planning estimates: APP-013 roughly 68%; governed APP-006 through APP-016 roughly 78%, not acceptance scores. Stop review-ready; do not start another section until reviewed.

### Earlier: owner/admin exhausted-intent retry API

- Owner reviewed initial confirmation durability and approved continuation. Added API-only `POST /communications/sms/enqueue-intents/:intentId/retry`, owner/admin only, with acknowledgment, fixed reason code and exact `expectedUpdatedAt` from the additive intent-list timestamp. Only exhausted FAILED/unacknowledged/current-state intents qualify; stale/missing/unsupported/currently processing/queued states cannot reset.
- Conditional reset and privacy-safe user audit are atomic. Concurrent submissions allow one reset/audit; old/repeated requests conflict. The endpoint never processes or sends; existing disabled delivery, state/consent/quiet-hour checks, canonical queue identity and five-failure bound remain authoritative. UI is unchanged/read-only; each retry cycle requires fresh review.
- Passed backend build/lint, 403 tests (3 existing skips), architecture/Prisma; UI lint/27 tests/build and 18-GET desktop/390px fixture regression. Real HTTP guards/validation/rate-limit tests use synthetic Firebase verification. Disposable local database proof verified concurrent retry, no queueing from reset, disabled processing, changed-state refusal and audit rollback; all 14 existing migrations passed, fixture removed and absence verified.
- No production/provider/configuration, merge, deploy or real-data action. Prior intent migration remains release-gated. Remaining recovery UI/acceptance, reschedule/cancellation durability, calendar reconciliation, events/templates/preferences/technician notifications/email/live acceptance stay open. Planning estimates: APP-013 roughly 65%; APP-006 through APP-016 roughly 77%. Stop review-ready; exact commands/limitations in APP-013 evidence.

### Earlier: initial confirmation intent durability

- Owner reviewed intent visibility and approved continuation. Initial booking finalization now atomically records the calendar reference, fixed confirmation SMS intent and customer audit. State/tenant guards prevent stale finalization; worker recovery supports confirmation plus technician departure only. Post-commit enqueue, operations-notification and logging failure cannot undo the booking.
- After acknowledged Calendar insertion, failed/ambiguous finalization retains the reservation and returns an office-review-required error; a retry without a calendar reference cannot claim confirmation. Calendar/database cross-system crash reconciliation remains manual and is not solved by this section. Reschedule/cancellation triggers retain their post-commit gap.
- Passed 362 backend tests (3 existing skips), build/lint/architecture/Prisma; UI lint/27 tests/build and desktop/390px fixture QA. Disposable local database proof used real scheduling/finalization/intent services with calendar/notification/delivery doubles; all 14 existing migrations passed, fixture removed and absence verified. No external sends or staging/production actions.
- Evidence and exact review commands: `evidence/APP-013/readiness-report.md`. Prior intent migration remains release-gated; remaining calendar reconciliation, reschedule/cancellation durability, recovery actions/policy, events/templates/preferences/email/live acceptance stay open. Planning estimates: APP-013 roughly 62%; APP-006 through APP-016 roughly 76%. Stop review-ready.

### Earlier: read-only enqueue intent visibility

- Owner reviewed the durable technician checkpoint and approved continuation. Added the read-only intent panel to `/app/notifications`: pending/stopped/acknowledged queue state, safe failure labels, claim/backoff timing, queue-event references and client-side filters over latest 100 tenant records. Acknowledgment is not delivery; no recovery action or provider control exists.
- History and intent reads fail independently; token/job edits and session clear invalidate both result sets and late responses. Fixture Chrome desktop/390px QA passed 18 GET-only requests including partial failures, filtering, credential clearing and private-field omission; new screenshots and exact rerun steps are in APP-013 evidence.
- Passed backend build/lint, 343 tests (3 existing skips), architecture/Prisma; UI lint, 27 tests/build. Critical audit 0 critical, unchanged 4 high/9 moderate; existing Browserslist warning. No database, provider/configuration, merge, deployment or real-data action.
- Appointment durability, recovery actions/policy, remaining events/templates/preferences/technician-recipient notifications/email and live acceptance remain open. Prior intent migration still requires separate release approval. Planning estimates: APP-013 roughly 58%; APP-006 through APP-016 roughly 75%. Stop review-ready.

### Earlier: durable technician enqueue intents

- Technician departure intent now commits atomically with status/audit; disabled-by-default recovery uses conditional leases, recorded-state validation and existing queue idempotency. Stale state stops; queue failures stop after five attempts. Appointment intent capture remains separate unfinished work.
- Read-only `/communications/sms/enqueue-intents` gives tenant-bound operational visibility without state hashes or private message fields. No UI/reset/replay control is added.
- Passed backend build/lint, 343 tests (3 existing skips), architecture/Prisma; UI lint/23 tests/build and fixture browser regression. A disposable local database applied all 14 migrations and verified real rollback, concurrency, ack-loss and tenant boundaries; it was removed. No provider or production action occurred.
- New migration `20260908120000_add_sms_enqueue_intents` requires separate release approval before deploying this code. Operator recovery UI/policy, appointment durability, remaining events/templates/preferences/email and live acceptance remain open. APP-013 roughly 55%; APP-006 through APP-016 roughly 75%, planning estimates.

### Earlier: read-only notification center

- `/app/notifications` now presents the latest 100 tenant-bound SMS history records with optional job UUID and status filters; counts are loaded-record counts only. Added dispatch navigation. No send/replay/template/email control exists.
- Token/job edits and clear-session invalidate pending reads and clear records. Token stays in memory; generic errors and explicit metadata rendering avoid private payload exposure. Sent remains delivery-unconfirmed.
- Passed backend build/lint, 323 tests (3 existing skips), architecture/Prisma; UI lint, 23 tests/build; fixture Chrome desktop/390px QA, error/empty/loading and late-response clearing. See APP-013 evidence and screenshots; no live backend/provider acceptance is claimed.
- APP-013 roughly 50%; APP-006 through APP-016 roughly 74%, planning estimates. Durable enqueue recovery, other events, template/preferences UI, technician notifications, email and acceptance remain open. No external send or release occurred.

### Earlier: technician on-the-way trigger

- A changed `on_my_way` queues the fixed customer SMS after the job/audit transaction commits; no-op retries and failed writes do not queue. Queue/logging failures cannot undo status and log no raw payload.
- The on-the-way digest includes the technician status timestamp so a later departure is distinct; obsolete departure/assignment state fails send-time validation. Earlier on-the-way digests fail closed.
- Final gates: build/lint, 323 backend tests (3 existing skips), architecture/Prisma; UI lint, 17 tests/build; critical audit passes with existing high/moderate findings. No rendered UI changed or external send occurred.
- APP-013 roughly 40%; APP-006 through APP-016 roughly 73%, planning estimates. Post-commit queueing still lacks durable outbox/reconciliation; a missed enqueue needs operator review, not a claim of guaranteed delivery. Other triggers, email, preferences, UI and acceptance remain open.

### Earlier: appointment lifecycle

- Confirmation, completed reschedule and completed cancellation now enqueue their fixed SMS template only after the calendar/job operation commits. Queue/identity failure is recorded without rolling back the appointment.
- Lifecycle-created events derive their idempotency identity from a SHA-256 digest of template-relevant canonical state instead of a caller-supplied request key. Manual operator queueing records the same state digest.
- Immediately before provider access, transactional events reload the tenant-scoped job and compare current lifecycle, schedule, recipient, brand and technician data to the queued digest. Invalid or changed state is dead-lettered with a bounded code; events from the earlier checkpoint without a digest fail closed.
- Regression evidence: 308 backend tests pass (3 existing skipped), build/lint/architecture/Prisma pass. Unchanged UI lint, 17 tests and build pass. No rendered UI changed, so no new browser artifact is applicable.
- Provider delivery remained disabled; no external message, configuration, migration, merge or deployment occurred. A narrow check-to-send race remains inherent after revalidation. Remaining APP-013 work includes other event triggers, email, preferences, UI and acceptance. APP-013 is roughly 35%; governed APP-006 through APP-016 roughly 72%.

- Continuation hardening now checks stored job/technician state before operator queue admission. Deleted jobs are unavailable; cancellation requires CANCELLED; confirmation/reschedule require a stored calendar reference/window; en-route copy requires an assigned EN_ROUTE technician; closed-job contradictions return 409.
- Regression evidence: 302 backend tests pass (3 existing skipped), build/lint/architecture/Prisma pass. See `evidence/APP-013/readiness-report.md` for the exact scope and remaining concurrency/send-time limitations. APP-013 is roughly 20%; governed APP-006 through APP-016 roughly 70%.

- Added four fixed/versioned contractor-branded customer SMS templates for confirmation, reschedule, cancellation, and technician-on-the-way events.
- Added an authenticated operator queue boundary that accepts no arbitrary recipient or message content; tenant, customer, schedule, and technician data are loaded server-side from the tenant-scoped job.
- Added privacy-safe, tenant-scoped communication history with job filtering and a 100-record bound.
- Reused the accepted BE-008 encrypted content, consent, quiet-hours, idempotency, callback, retry, dead-letter, and delivery-disable controls.
- No lifecycle automation, operator UI, migration, provider call, configuration, merge, or deployment is part of this checkpoint.
- Evidence: `evidence/APP-013/readiness-report.md`.

## APP-012 Review Checkpoint

- Branch: `codex/app-012-payment-gate` from backend `origin/main` at `8247a0a`.
- Implemented one bounded vertical slice: the provider-independent payment-before-dispatch gate.
- `depositRequired` and `serviceFeeRequired` now share one fail-closed reducer across intake readiness and dispatch.
- Required jobs stay in `NEW_REQUEST`, expose a privacy-safe payment-gate status, return no eligible recommendation and reject new assignment until canonical payment status is `SUCCEEDED`.
- `/app/dispatch` shows the lock reason and disables the assignment controls; desktop and 390px browser evidence is in `evidence/APP-012/`.
- Backend build/lint, 24 suites and 175 tests, architecture and Prisma validation pass. UI build/lint and 4 suites/17 tests pass.
- Isolated local HTTP proof verified pending -> HTTP 409/no mutation/no audit and simulated succeeded -> unlocked/recommendation. The fixture was removed.
- No Stripe call/configuration, production migration, deployment, IAM, billing or real-data action occurred.
- Evidence: `evidence/APP-012/readiness-report.md`.

## APP-012 Payment Request Checkpoint

- Continued `codex/app-012-payment-gate` with one bounded backend-only payment/deposit request section.
- Added authenticated owner/admin/dispatcher `POST /jobs/:jobId/payment-requests` and privacy-safe `GET /jobs/:jobId/payment-request` endpoints.
- Required amount/currency come only from the job's tenant policy and pricing snapshots. Stale, closed, missing/cross-tenant, incomplete-pricing and unready connected-account cases fail before provider access.
- Checkout creation is idempotent and uses a direct Stripe charge on the contractor tenant's connected account with a zero Signmons application fee. Only a SHA-256 request-key hash is stored; provider identifiers and checkout URLs stay out of tracking/audit projections.
- Added request success/failure audits and migration `20260904100000_add_payment_request_tracking`.
- Backend build/lint, 26 suites and 189 tests, architecture and Prisma validation pass. A disposable local PostgreSQL schema passed all migrations and authenticated POST/replay/GET proof with one success audit, then was removed.
- No live Stripe request, Stripe/IAM/secret configuration, staging or production migration, deployment, billing or real-data action occurred. No rendered UI changed, so no new visual browser artifact was warranted.
- APP-012 is approximately 60% complete; APP-006 through APP-016 is approximately 61% complete.

## APP-012 Webhook Transition Checkpoint

- Added public `POST /webhooks/stripe` with exact-raw-body Stripe signature verification and a five-minute replay tolerance.
- Connected-account events resolve the tenant from the stored account binding, then resolve only a payment belonging to that tenant and destination account. Paid events must match the trusted amount and currency.
- Existing `StripeEvent` storage makes delivery idempotent; duplicate delivery does not repeat payment or audit mutations. Stored payload/audit evidence is bounded and excludes customer payload fields and provider identifiers.
- Handles paid Checkout completion, asynchronous success/failure, Checkout expiration, PaymentIntent failure, and full/partial charge refunds. Late success cannot overwrite a refunded state.
- Production Checkout configuration now fails closed without `STRIPE_WEBHOOK_SECRET`.
- Backend build/lint, 27 suites and 200 tests, architecture and diff checks pass; 1 suite/3 tests remain skipped by the existing database-test policy.
- A separate sandbox exercise completed contractor onboarding and a $100 Checkout payment. No live-mode payment, endpoint configuration, production secret change, migration, deployment, or release occurred.
- Stripe CLI then forwarded a genuine signed Connect `checkout.session.completed` event to the compiled local backend on an isolated disposable database. A mismatched amount returned HTTP `422` with no mutation; the aligned event changed `PENDING` to `SUCCEEDED` with exactly one processed event and one bounded webhook audit, while the application fee remained zero.
- All temporary processes, database/schema fixtures, and ephemeral-secret logs were removed. The shared historical `legacy_2025` archive was preserved after its fixed name blocked the first schema-scoped migration attempt.

## APP-012 Customer Recovery Checkpoint

- Extended the existing signed customer booking-link action boundary with `continue_payment`; the customer needs no separate account, and an ordinary booking-status read never returns the Checkout URL.
- Recovery returns only the already-created session when the tenant-scoped payment is pending, both local and provider expiry are in the future, the provider reports it open and unpaid, and the stored destination still exactly matches the tenant's enabled connected account.
- Recovery does not create a new Checkout or charge. Its bounded customer audit excludes the Checkout URL and provider/account identifiers.
- Added a responsive pending-payment action to `/appointment/manage` and a `/payment/status` success/cancel page. The success page does not claim fulfillment from the redirect; webhook state remains authoritative.
- Local browser QA passed at desktop and 390px: the pending-payment action is visible and 50px high, the booking page remains available, and there is no horizontal overflow. Success and cancel return states rendered without application console warnings/errors.
- Final gates pass: backend build/lint/architecture/Prisma validation and 27 suites/206 tests; UI lint/static build and 4 suites/17 tests.
- This section remains review-only. No live-mode call, persistent Stripe configuration, migration, deployment, or release occurred.
- APP-012 is approximately 70% complete; APP-006 through APP-016 is approximately 63% complete.

## APP-012 Operator Payment Visibility Checkpoint

- Added an authenticated payment operations panel to `/app/dispatch` for owner/admin/dispatcher roles. It shows the job's trusted request amount, request status/expiry, and a bounded signed-event timeline.
- Operators can create a request only through the existing server-authoritative endpoint. The UI supplies the currently loaded job version and a new UUID idempotency key; the temporary Checkout URL appears only in the successful authorized response for opening or copying.
- Added tenant/job-scoped `GET /jobs/:jobId/payment-events`, capped at the newest 20 events and filtered through the job's internal payment ID. It returns only internal row ID, bounded type/status and timestamps—never Stripe event/account/session/payment-intent IDs, payloads or error text.
- Desktop and 390px browser QA passed with trusted `$100.00` fixture display, active-request lock, human-readable verified event, 44px phone control, and no horizontal overflow.
- This section remains review-only. No live Stripe call, persistent configuration, migration, deployment, merge, or release occurred.
- Final gates pass: backend build/lint/architecture/Prisma validation and 27 suites/208 tests; UI lint/static build and 4 suites/17 tests.
- APP-012 is approximately 80% complete; APP-006 through APP-016 is approximately 65% complete.

## APP-012 Governed Payment Exception Checkpoint

- Added owner/admin-only `POST /jobs/:jobId/payment-exception` with approve/revoke actions, normalized 10-500 character reason, throttling, no-store response, tenant scope and optimistic job concurrency.
- Approval requires the job's trusted policy snapshot to explicitly select `paymentGateMode: manual_override` plus a currently active/trialing Growth, Pro or Enterprise subscription period. Starter and missing/expired entitlements fail closed before mutation.
- A successful exception uses the distinct `PAYMENT_EXCEPTION_APPROVED` gate reason and leaves canonical payment truth unchanged; pending remains pending rather than being relabeled paid.
- Approval and revocation atomically update the job policy snapshot and write bounded user audits. Revocation does not require an ongoing advanced entitlement, preventing a downgrade from trapping an unsafe exception open.
- Focused guard/service/policy tests pass for role denial, entitlement denial, governed unlock, untrusted exception rejection, revocation and stale-write protection. This backend-only section changes no rendered UI.
- No database schema change, Stripe call/configuration, deployment, merge, or release occurred.
- Final gates pass: backend build/lint/architecture/Prisma validation and 28 suites/221 tests; unchanged UI lint/static build and 4 suites/17 tests.
- APP-012 is approximately 88% complete; APP-006 through APP-016 is approximately 67% complete.

## APP-012 Final Acceptance Preparation

- Added `evidence/APP-012/release-checklist.md` with a linked acceptance matrix, exact Stripe Connected accounts event set, vault/restricted-key requirements, continuous staging acceptance sequence, negative cases, cleanup, rollback/monitoring and separate live release gate.
- The linked local lifecycle evidence receives a conditional pass: operator request, signed customer recovery, genuine Stripe CLI Connect transition, canonical dispatch unlock, bounded operator visibility and governed exceptions are proven across isolated evidence.
- This is not a deployed end-to-end claim. Continuous staging execution requires explicit owner authorization for staging deployment, migration and Stripe sandbox endpoint configuration.
- No Stripe endpoint, secret, IAM policy, database, deployment, merge, release or live-mode state was changed in this section.
- APP-012 is approximately 95% complete; APP-006 through APP-016 is approximately 68% complete.

## APP-012 Webhook Mode Boundary Checkpoint (2026-09-07)

- Added explicit `STRIPE_WEBHOOK_LIVEMODE` configuration and rejected handled signed events before database access when their top-level Stripe `livemode` does not match the configured environment.
- Production validation now requires an explicit webhook mode whenever Stripe Checkout or webhook credentials are configured and rejects recognizable live/test key prefixes that conflict with it.
- Focused webhook/config validation passed 2 suites and 25 tests. Full backend build/lint, 28 suites and 224 tests, architecture, Prisma validation and the critical audit gate pass; unchanged UI lint/build and 4 suites/17 tests also pass.
- This server/config-only hardening changes no rendered UI, so the existing September 6 desktop/390px browser evidence remains applicable and no new visual artifact was warranted.
- No endpoint, credential, IAM policy, database, payment, deployment, merge, release or customer state was changed. APP-012 remains approximately 95% complete and unreleased pending explicit staging acceptance approval.

## APP-012 Governed Staging Acceptance (2026-09-07)

- Owner-authorized sandbox work deployed reviewed commit `27d595da21406704b6bc66804ba03d2e90643b23` as Cloud Run revision `signmons-calldesk-staging-app012correct`, now serving 100 percent of staging traffic with explicit test webhook mode.
- The active Stripe `Signmons LLC` test destination receives the six approved Connected accounts events at the staging `/webhooks/stripe` endpoint. Signing material is held in Secret Manager version 5 and is not recorded in source or evidence.
- A genuine Stripe CLI event reached the deployed endpoint with a valid signature and failed closed as an unrecognized generic payment. The exact owner-submitted `$100.00 USD` paid Checkout event then returned 200 through a secure deployed replay and changed canonical state from `PENDING` to `SUCCEEDED` with zero application fee, tenant destination match, one processed event, one bounded transition audit and dispatch unlock.
- Duplicate replay returned 200 without adding a second event or transition audit. The disposable tenant and Identity Platform operator were deleted; temporary secret/event files and temporary IAM grants were removed.
- A new post-destination disposable `$100.00 USD` Checkout then delivered automatically from Stripe with HTTP 200. Canonical status became `SUCCEEDED`, fee stayed zero, tenant destination matched, dispatch unlocked and exactly one processed event/transition audit was stored. Workbench resend also returned HTTP 200 with `duplicate: true` while database counts stayed one.
- Evidence: `evidence/APP-012/release-checklist.md`. APP-012 sandbox implementation and acceptance are 100% complete; APP-006 through APP-016 is approximately 69% complete. Merge, production release, live-mode configuration and a real transaction remain separately approval-gated.

## APP-012 Release (2026-09-07)

- Owner authorized merge and staging release. PR `#14` merged the accepted branch to backend `main` at `068f4c27daf00ee4967fd5d77432e0605fedf044`.
- Release gates passed before merge: backend build, 224 tests with 3 policy-skipped, architecture and Prisma validation; UI lint/static build and 17 tests.
- Cloud Build `dd7ca7ec-1777-45b6-8659-fba8998a9b63` produced image `068f4c2` with digest `sha256:838121ce33dc17343ec2182bee83d39118626a68aa702802b13205635d501a33`.
- Migration execution `signmons-calldesk-migrate-pgr84` completed successfully from that digest. Cloud Run revision `signmons-calldesk-staging-app012release` serves 100 percent of staging traffic.
- Firebase Hosting published the exact merged build. `/app/dispatch`, `/appointment/manage` and `/payment/status` return HTTP 200; backend liveness/readiness return 200, approved-origin CORS is present and unsigned Stripe webhook traffic fails closed with 400.
- Temporary build bucket, Artifact Registry and logging grants were removed and `signmons-build` was disabled. The sandbox Stripe destination and vault secret remain staging-only; no live-mode key, production payment or real transaction was authorized.
- APP-012 is Done. APP-013 is promoted to Now without beginning implementation.

## APP-011 Implementation

- Added a public, rate-limited `POST /appointments/manage` boundary that treats the HMAC secure-link token as authority and keeps the existing tenant-authenticated webchat endpoint compatible.
- Added a responsive customer route at `/appointment/manage` with request, appointment, technician and payment status summaries.
- Added explicit `confirm` and `request_reschedule` actions; existing availability, direct reschedule and cancellation behavior remains compatible.
- Preserved the existing lowercase appointment `state` contract and added richer customer status as `bookingState`.
- Customer confirmation, reschedule request and direct reschedule events are tenant-scoped and audit logged with `AuditActorType.CUSTOMER`.
- Dispatch detail now exposes the latest customer response and a short customer-booking event timeline.
- Secure-link payloads remain in the URL fragment, are not sent in query strings and are never returned to the dispatcher UI.

## Validation

- Backend: build passed; 163 tests passed with 3 skipped; architecture check passed.
- Frontend: lint passed; static production build passed; 17 tests passed.
- Browser QA: desktop and phone layouts passed with no horizontal overflow; touch actions are 50px high; reschedule disclosure and accessible labels verified.
- Repository-wide backend lint still reports five pre-existing APP-010 findings in `src/jobs/routing.service.ts`; lint is not an APP-011 backend completion gate and APP-011 introduced no lint findings.
- Evidence: `evidence/APP-011/readiness-report.md` and customer status screenshots in the same directory.

## APP-011 Release

- Cloud Build `5c478614-709a-4f15-9579-e964d7bcca67` produced image `28d394f` with digest `sha256:6721f0d940fd97890d6c75e5ba7e4e5de3e4c1163b4f20a3f975fac80701d787`.
- Migration execution `signmons-calldesk-migrate-xztrh` completed successfully.
- Cloud Run revision `signmons-calldesk-staging-00024-wwn` serves 100 percent of staging traffic.
- Firebase Hosting published `/appointment/manage`; live liveness, readiness, CORS and fail-closed secure-link checks passed.
- Temporary build access was fully revoked and `signmons-build` was disabled after the build.

## Next Actions

1. Review the latest APP-013 soft-deleted customer-management safeguard on `codex/app-013-transactional-messaging` (PR #21): filtered/defensive loader, uniform missing-record 400, stale action/payment UI cleanup, twelve unit cases and 63 database refusals. Audits clean. Already-deleted-at-load access is closed; in-flight races and remaining legacy consumer guards/repair stay open. No activation or ticket transition.
2. Keep Stripe sandbox and live credentials separated; APP-012 live-mode activation remains separately approval-gated.
3. Keep Stripe secrets server-side and maintain the contractor-to-customer payment boundary; Signmons tenant pricing remains subscription-only.
4. After review, complete one bounded authorized CREATE scheduling-orchestration section preserving upstream tenant/auth/payment/availability guards and explicit reader/worker ownership. Do not activate the executor alone. Other payment/entitlement state and post-preflight races, reschedule/cancel and SENDING recovery, and dependency-override maintenance stay open; confirmed reachable security issues take priority. Migration, retention/provider configuration, live acceptance, release and external sends require separate approval.

## Restart Commands

```bash
git status --short
npm run -s build
npm test -- --runInBand
npm run -s arch:check
cd ui && npm run -s lint && npm run -s build && npm test -- --runInBand
```
