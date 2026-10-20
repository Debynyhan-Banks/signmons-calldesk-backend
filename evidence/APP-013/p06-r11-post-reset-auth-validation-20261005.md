# P06-R11 post-reset authentication validation preparation

- Plan: `1f681cc1-bf0a-4ace-a4b6-f4dc806a46ec`
- Operation: `c61dba09-5f4c-4bc4-932c-dfc2575b57cd`
- Private root: `/private/tmp/r11-db-auth-diagnostic-20261005-0825`
- Proposed window: 8:25-8:50 a.m. Eastern on 2026-10-05; start before 8:35 a.m.
- Query: `SELECT 1` against the identified direct and pooled production endpoints
- Private input: owner enters the newly generated password once in a hidden terminal
- Persistence: fixed classifications and timestamps only
- Exclusions: all mutations, customer actions, paid actions, and retry

Preparation does not authorize execution or later credential cutover. No scope deviation; accepted baseline remains 3/8.

## Result

The operation completed once at `2026-10-05T12:28:53.076396Z`:

- Direct endpoint: `AUTH_REFUSED`
- Pooled endpoint: `AUTH_REFUSED`
- Temporary pgpass file: absent after execution
- State: consumed; never rerun

This demonstrates refusal at the two fixed hosts. It does not distinguish a host/branch mismatch from private-input mismatch. The next step is metadata-only comparison of the production Connect hostname, without displaying or copying a connection string or password.
