# APP-013 / 2B / P06-R11 unmapped shared-secret replacement decision — 2026-10-03

Consumed operation `e13000fe-7d13-4e9c-9e39-a164873c98ce` returned terminal `R11_POOLED_HOST_MAP_NO_MATCH`: shared secret version 2 matches neither direct nor pooled canonical hostname for either current endpoint in the only visible Neon project. The operation is consumed and must never be rerun. No external mutation occurred.

Fresh read-only evidence now completes the replacement card:

- production branch `br-young-term-ayfi7ist` has current endpoint `ep-nameless-frog-ayk5gr5y` and `neondb_owner`;
- isolated child `br-sparkling-sun-ay6gr5e8` has endpoint `ep-jolly-flower-ayc6w9hv`, its own `neondb_owner`, and the three limited P06 roles;
- Neon documents that password resets are branch-scoped and old sessions are not closed by the reset alone;
- current Google metadata confirms normal `app013bounds` and the migration job use shared `latest`, while `p06-intake-disabled` uses unchanged child secret version 2;
- exact baseline image/configuration, current service/job metadata, secret-version state and historical tag inventory are recorded without reading any value.

Governance `APP013_P06_R11_UNMAPPED_SHARED_SECRET_REPLACEMENT_DECISION_20261003.md` recommends one attended replacement/containment operation. It resets both current branch owner credentials privately, creates one numeric pooled production URL version in the existing shared secret, deploys an exact `app013bounds` clone, proves database-backed readiness, repoints but does not run the migration job, cuts traffic, removes eight obsolete shared-secret tags, contains proven old sessions and disables old version 2 without destroying it. The limited child secret and roles remain unchanged.

This is a complete proposal, not execution authority. No source, password, secret, role, revision, traffic, tag, job or session changed. Owner selection of Alternative 1 and a future 90-minute Eastern window are next. P06 remains 12/14; R11/full R12 remain open; accepted milestones remain 3/8. Proposed scope deviation is recorded before implementation.

## Owner approval and package preparation

The owner approved Alternative 1 for October 3, 2026, 7:30–9:00 a.m. Eastern. Fixed plan `b90fd97f-2c71-4b19-a897-f2b8733824c0`; operation `d9412e4d-5fe7-4a3f-bf79-a37bafd5e880`. External stages begin before 8:15 and stop by 9:00.

The self-contained coordinator and focused test are implemented without application, schema, migration or dependency changes. Four fictional tests cover password encoding, exact baseline transformation, strict inventory refusal and one-use sanitized stop; compilation, architecture and whitespace pass. Final source SHA-256 `fc41cfb57cb24b3be188be5643546df1766d1a9920c32231690df485f1f59de2`; installed 0700/0600 at `/private/tmp/r11-unmapped-secret-replacement-20261003-0730-v2`; installed `--check` returned `R11_REPLACEMENT_CHECK_PASSED_NO_ACTION` with no action markers.

The first installed package was superseded before action because private input depended on an unbound external module. Its approval file was renamed, no action markers exist and it cannot validate. Use only v2. No external mutation occurred during preparation.
