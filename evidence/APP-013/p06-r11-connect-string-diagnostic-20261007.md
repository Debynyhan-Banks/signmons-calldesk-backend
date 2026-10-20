# P06-R11 Connect-string diagnostic preparation

Section APP-013/P06-R11. Preparation is owner-approved; live execution is not yet approved.

- Plan: `b1849763-4158-4e16-afb5-ee8613589967`
- Operation: `a8836952-c1c8-4da5-a2c6-00b214cf8cd2`
- Proposed root: `/private/tmp/r11-connect-string-diagnostic-20261007-1315`
- Proposed window: 1:15-1:40 p.m. Eastern on 2026-10-07; start before 1:25 p.m.
- Input: complete current Neon production Connect URL through hidden TTY only
- Read: `SELECT 1` against fixed direct and pooled production endpoints after exact metadata match
- Retained output: input host class, target match, fixed endpoint classifications and timestamps only
- Exclusions: password reset, secret/version/IAM/deployment/traffic/job/session/database-row/customer/message/booking/payment action and retry

Expected observable finish is one sanitized immutable result or terminal stop. Preparation does not authorize execution or credential cutover. Accepted baseline remains 3/8. No scope deviation.

Prepared helper SHA-256: `c4a7575ab9517e5b015f6c51ff0547e3eac4a1b4dfd770508b77b8b8622475d4`. Seven focused tests, compilation, architecture, governance and whitespace checks pass. Installed source matches, modes are 0700/0600, and no action marker exists.

The approved 1:15-1:40 p.m. package expired unused; no diagnostic marker or database connection exists. It must not be run. Fresh successor plan `4002cd56-4d00-488a-b580-c35b046e93d9`, operation `e3557f6c-ff07-4d75-b8a3-70d5b8122cb4`, root `/private/tmp/r11-connect-string-diagnostic-20261007-1810`, is proposed for 6:10-6:35 p.m. Eastern with a 6:20 p.m. start deadline. Boundaries are unchanged and fresh execution approval is required.

The successor ran once at `2026-10-07T22:14:05.900956Z` and returned `R11_CONNECT_STRING_TARGET_MISMATCH`. Both endpoint probes are `NOT_RUN`; input host class is `UNCONFIRMED`; no pgpass remains. The package is consumed and must not be rerun. No database connection or external mutation occurred. Owner clarification of the copied Neon control and non-secret selections is required before proposing another operation.

The owner clarified that only the password was pasted, fully explaining the safe target mismatch. Fresh successor plan `1d0f0a27-c198-4f9f-862f-65d2f8fca6b1`, operation `c3ba1c94-cfd6-4de3-a255-2cff3c261eb8`, root `/private/tmp/r11-connect-string-diagnostic-20261007-1830`, is proposed for 6:30-6:55 p.m. Eastern with a 6:40 p.m. start deadline. The hidden prompt now explicitly requests the full `postgresql://` Connection string URL, not a password or PSQL command. All other boundaries are unchanged.

The owner then copied the full Connection string. The successor ran at `2026-10-07T22:34:24.390152Z` and returned `R11_CONNECT_STRING_TARGET_MISMATCH`; both probes are `NOT_RUN`, input host class is `UNCONFIRMED`, and no pgpass remains. It is consumed and must not be rerun. Next is local clipboard-only sanitization of non-secret URL metadata before any new live proposal.

Sanitized clipboard inspection showed blank scheme/host/role and the Python sanitizer command as the path. The command copy had replaced the Neon URL, fully explaining the mismatch. Fresh successor plan `d1bc6691-015a-4589-96a0-b75869683f7f`, operation `23070bd9-a3c0-48c0-8f48-81dc723470df`, root `/private/tmp/r11-connect-string-diagnostic-20261007-1850`, is proposed for 6:50-7:15 p.m. Eastern with a 7:00 p.m. start deadline. Its prompt waits 240 seconds and instructs the owner to copy the URL only after the hidden prompt appears. All other boundaries are unchanged.

The owner followed that sequence. The operation ran at `2026-10-07T22:56:50.638180Z` and returned `R11_CONNECT_STRING_TARGET_MISMATCH`; both probes are `NOT_RUN`, input host class is `UNCONFIRMED`, and no pgpass remains. It is consumed and must not be rerun. Local helper `/private/tmp/r11-neon-url-metadata-20261007.py`, SHA-256 `85a886fe32e4b59bf32f170bc0cb65a601bf6ab983627a4ffc4933f3a9923142`, is prepared to print only non-secret metadata and mismatch categories with no network action or persistence.

Sanitized metadata identified the sole mismatch as `HOST`: current pooled host `ep-nameless-frog-ayk5gr5y-pooler.c-5.us-east-2.aws.neon.tech`; all scheme/port/role/database/password-presence/query checks matched. The helper's fixed hosts had omitted `.c-5`. Corrected exact hosts preserve that routing segment and remove only the documented `-pooler` suffix for direct. Fresh plan `ffc2e0fc-12f2-4936-b8ee-d0617d5675c2`, operation `35d42af5-b938-4783-a053-80a1a0706de2`, root `/private/tmp/r11-connect-string-diagnostic-20261007-1915`, is proposed for 7:15-7:40 p.m. Eastern with a 7:25 p.m. start deadline. Fresh approval is required.

The corrected operation completed at `2026-10-07T23:20:06.069806Z` with `target=MATCH`, `inputHostClass=POOLED`, direct `ACCEPTED`, and pooled `ACCEPTED`. Attempt/result markers exist, no pgpass remains, and the operation is consumed. This proves the current private production credential authenticates at both exact endpoints. No secret, revision, traffic, job, session, database row or customer state changed; cutover remains separately gated.
