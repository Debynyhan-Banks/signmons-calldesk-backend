# APP-013 / 2B / P06-R11 exposed administrator credential qualification — 2026-10-02

## Result

Read-only repository and Google Cloud metadata establish that the credential exposed during the enabled35 attended helper was the owner-supplied inherited `neondb_owner` administrator password, not the limited P06 runtime credential. The exposed value is omitted from all evidence.

No Neon role/password, Secret Manager payload/version, Cloud Run service/job/revision/tag/traffic setting or database session changed in this qualification.

## Current separation

- `signmons-staging-p06-child-database-url:2` is the recorded working limited `p06_intake_runtime` connection for the child. Version 2 is `ENABLED`; invalid version 1 is `DESTROYED`.
- enabled35 and tagged `p06-intake-disabled` bind `DATABASE_URL` to that child secret at numeric version 2.
- The child secret does not contain the exposed administrator credential and must not be replaced as part of administrator rotation.
- `signmons-staging-database-url` has version 2 `ENABLED` and version 1 `DISABLED`. No payload was read in this qualification.
- Normal revision `signmons-calldesk-staging-app013bounds`, eight other reachable historical tags, and the `signmons-calldesk-migrate` job bind `DATABASE_URL` to `signmons-staging-database-url:latest`.
- The migration job was not executed. Its latest historical execution remains the prior successful September 7 execution; its current definition is not approval to run it.

The service is generation 108. Normal traffic remains 100 percent on `app013bounds`; the enabled35 test tag is absent. The current service template is enabled35 and points to the limited child secret, so it must never be used as the source for a normal-traffic credential-rotation revision. Any normal replacement must be derived from the exact `app013bounds` revision and preserve its image and configuration except for the reviewed database-secret version change.

## Risk boundary

Prior governed evidence established that the unprotected child inherited `neondb_owner` credentials and that the same credential may authenticate against parent or sibling branches. Neon branch endpoints isolate data paths, but that does not make a copied password branch-specific. Reset behavior and the complete current branch inventory must be verified before mutation; do not assume one branch reset contains the exposure everywhere.

Google documents that Cloud Run resolves secret environment variables at instance startup and recommends numeric version pinning rather than `latest`. Updating a Secret Manager version does not replace a value already injected into a running instance, and a database password change does not by itself close existing database sessions. Safe containment therefore needs a coordinated role reset, secret version, replacement normal revision, job reference update or explicit retirement, traffic/readiness proof and session closeout. It cannot be reduced to adding a child-secret version.

## Proposed next decision

Governance `APP013_P06_R11_EXPOSED_ADMIN_CREDENTIAL_ROTATION_DECISION_20261002.md` defines the finite coordinated containment sequence and alternatives. External execution remains pending explicit owner approval of that complete sequence and a future attended window.

## Approved preparation and installed identity package

The owner's response to the combined approval/window question records Alternative 1 and October 2, 9:30–11:00 p.m. Eastern. Plan `bda2718d-9f8d-4701-9913-c9c95609eae4`; operation `0580681c-e4c7-4ac1-a08d-b5f2756bfb80`.

New local helper `scripts/p06-r11-shared-secret-identity.py` and focused tests implement only the approved sanitized identity read. It is bound to shared secret version2, expected parent host, `neondb_owner`, `neondb`, fixed window and private root. Seven focused positive/refusal/one-use/window/schema/redaction tests pass; Python syntax, architecture, secret-pattern, governance and whitespace checks pass.

The package is installed 0700/0600 at `/Volumes/Signmons-P06/r11-credential-rotation-20261002-2130`. Installed helper SHA-256 is `477c2c9da82a25a46f503869b3e298d3cb9d163a3ae8906b898a479e8863560a`; approval SHA-256 is `f2df96534742f9b85af9945dcd4fe126c4b12d12d4d53c04d69d315c30206908`. Installed `--check` returned `R11_CREDENTIAL_IDENTITY_CHECK_PASSED_NO_ACTION`. No attempt/result/stop marker exists and no secret payload was accessed during preparation.

## Early invocation refusal

At approximately 8:35 and 8:37 p.m. Eastern, before the fixed 9:30 p.m. start, the owner invoked the installed `--run` command and reported `R11_SHARED_SECRET_IDENTITY_REFUSED_OR_CONSUMED` each time. Immediate local readback after each report found no `identity-attempt.json`, `identity-result.json` or `identity-stop.json`; the private root and files retained their required 0700/0600 modes, and both installed hashes still matched the reviewed package.

The reviewed helper validates the fixed window before it reserves `identity-attempt.json` or calls the Secret Manager accessor. At 8:35 p.m. the window predicate necessarily returned `WINDOW`, which the command-line wrapper intentionally reduced to the generic refusal text. This was a deterministic pre-action refusal: no operation was reserved, no secret payload was accessed and operation `0580681c-e4c7-4ac1-a08d-b5f2756bfb80` remains unused. The unchanged approved package may receive its single initial invocation from 9:30 p.m. through 9:49:59 p.m. Eastern. No invocation is permitted before then, and any in-window attempt/result/stop or uncertainty consumes the operation.

## In-window identity result

The single authorized invocation reserved operation `0580681c-e4c7-4ac1-a08d-b5f2756bfb80` at 9:32:52 p.m. Eastern and completed at 9:32:53 p.m. with `R11_SHARED_SECRET_IDENTITY_MISMATCH`. Sanitized receipt readback verifies the PostgreSQL scheme, `neondb_owner` role, password presence, default/5432 port and `neondb` database matched. The host did not match the fixed expected parent endpoint. No raw URL, host, password, payload or payload hash was persisted or printed.

The result and attempt records are present, no stop record exists, installed hashes and 0700/0600 modes still match, and the operation is consumed. Never rerun it. Under the approved card, the unexpected host stops all shared-secret mutation, normal-revision deployment, traffic cutover, migration-job reference update, session termination and old-version retirement. The credential exposure still requires containment, but current evidence cannot safely map shared secret version 2 to the expected parent branch. A new, separately approved metadata-only host-to-Neon-branch mapping decision is required before any mutation can be proposed. No credential, secret version, role, revision, tag, traffic, job or database session changed.

P06 remains 12/14. R11/full R12 remain open and accepted walkthrough milestones remain 3/8. No scope deviation from the approved security prerequisite.
