# APP-013 / P06 R11 category-binding repair

Date: 2026-09-21

Status: locally complete under the owner-approved alternative 1. No live execution or acceptance increase.

## Acceptance trace

- Section: P06-R11 repair within the existing 2B connected intake journey.
- Demonstrated gap: the customer draft classification is a fixed enum such as `COOLING`, while the activated internal category is named `Regular initial visit / diagnosis`. The controlled reader previously queried the catalog by the draft enum and returned 409 before address reservation.
- Approved behavior: pass the activation-selected category ID through the server-owned runtime composition and use that ID for current-category, authority and admission checks. Keep `draft.issueCategory` validated and preserved as customer input.
- Connected workflow effect: the protected submit can now advance from the reviewed draft to the existing phone/address verification and atomic admission path when the internal category label differs from the customer classification.

## Implemented boundary

- `ControlledIntakeComposition` requires and forwards `serviceCategoryId` as an internal resource.
- `loadControlledIntakeRuntime` supplies `allowedServiceCategoryIds[0]`; no browser field or public contract was added.
- `controlledSubmissionReader` validates the ID as a UUID, reads the exact tenant/category under the existing transaction, and delegates the same scope to `ControlledIntakeAuthority`.
- The draft enum remains in the immutable submission digest and persisted draft. It is no longer treated as a database category name.
- Existing tenant/category existence, activation allowlist, policy digest, database clock, session, replay, concurrency, atomic write and false downstream-authority controls remain in place.

No schema, migration, packet format, provider adapter, secret, IAM or deployment behavior changed.

## Verification

- Focused Jest: 145 passed across continuation, controlled composition and runtime specifications.
- Full Jest with loopback access: 129 suites passed, one skipped; 2,360 tests passed and three skipped.
- Build, lint and architecture checks passed.
- Disposable PostgreSQL 18 plus headless-browser harness passed all 26 migrations, restricted runtime-role checks and eight connected 390/1440 scenarios. Its controlled fixture used customer classification `COOLING` with the distinct internal category name `Regular initial visit / diagnosis`.
- The connected synthetic path proved one admission, exact replay, concurrent duplicate safety, missing-phone/outside/unknown/revoked refusal, explicit correction, rollback and no false booking or delivery authority.
- Synthetic provider counts were 24 phone calls and 14 address calls; live provider calls were zero. The owned disposable database was dropped and PostgreSQL stopped.
- Final temporary evidence: `/private/tmp/signmons-runtime-role-cgdWkt/evidence`. It contains fictional data only and is supplemental to the committed assertions.

The first unprivileged full-suite run was blocked only where tests attempted local socket binding (`EPERM`). The exact suite then passed with loopback access. No network provider was contacted.

## Remaining boundary

P06 remains 12/14. R11 still requires a fresh, separately approved supervised connected browser journey and owner acceptance. Full R12 remains open. The next live sequence requires a new owner-selected window, separately authorized read-only refresh and packet preparation, then separate exact execution approval. No consumed command may be reused.

No scope deviation beyond the approved alternative 1.
