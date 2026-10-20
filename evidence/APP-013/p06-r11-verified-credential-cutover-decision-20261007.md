# P06-R11 verified credential cutover decision evidence

The current production Connect credential matched exact `.c-5` metadata and authenticated to direct and pooled production endpoints at `2026-10-07T23:20:06.069806Z`. The diagnostic is consumed and retained no pgpass.

Fresh read-only Google inventory:

- normal/app013-bounds: 100% `signmons-calldesk-staging-app013bounds`
- failed candidate tag: `app013-db-rotation` -> `signmons-calldesk-staging-app013dbrot1`, 0%
- preserved disabled tag: `p06-intake-disabled` -> `signmons-calldesk-staging-app013p06disabled`, 0%
- baseline and migration job: `signmons-staging-database-url:latest`
- shared versions: 1 disabled, 2 enabled, 3 enabled
- child versions: 1 destroyed, 2 enabled
- latest migration execution: `signmons-calldesk-migrate-jrq7h`, completed `2026-09-07T22:42:33.570408Z`

No secret value was read and no external state changed. The decision proposes one future separately approved numeric-version cutover: hidden exact URL validation, one new shared version, exact baseline clone at zero traffic, database readiness, job reference-only pin, traffic/tag cutover, exact session containment, versions 2/3 disable-not-destroy and final readback. No reset, obsolete historical-tag removal, migration execution, child-secret change, customer action or enabled intake is included.

Accepted baseline remains 3/8. No scope deviation.

The owner approved the narrowed cutover scope on 2026-10-07. An attended 90-minute Eastern window and exact finished-package execution approval remain required before any external mutation.

The owner selected 7:45-9:15 p.m. Eastern, first preflight before 8:15. Plan `ffcaf1f0-6c0d-4ac8-9358-52bdae15f000`; operation `3db3aa7d-974f-466e-a536-b5330be53afa`; root `/private/tmp/r11-db-auth-recovery-20261007-1945`; replacement `signmons-calldesk-staging-app013dbrot2`; candidate tag `app013-db-recovery`. Finished-package approval remains required.

Installed coordinator SHA-256: `d70c4090cf49676d8282bea6614b3ad355dd332925bf1e0967803d5f212504c7`. Five focused tests, compilation, architecture, both governance suites and whitespace pass. Root/helper/support modes are 0700/0700/0600 and no action marker exists. Exact execution approval remains pending.

Execution completed once with `R11_DB_AUTH_RECOVERY_VERIFIED` at `2026-10-08T00:20:58.000137Z`. Independent closeout confirms dbrot2/app013-bounds normal100%, readiness200, revision and job numeric version4, job execution count7/latest September7 execution unchanged, shared4 enabled, shared2/3 disabled-not-destroyed, child2 enabled, preserved disabled tag, no other tags, zero pre-reset owner sessions and no credential pattern in saved JSON. All stages are consumed; never rerun. R11/fullR12 remain open; accepted3/8. No scope deviation.
