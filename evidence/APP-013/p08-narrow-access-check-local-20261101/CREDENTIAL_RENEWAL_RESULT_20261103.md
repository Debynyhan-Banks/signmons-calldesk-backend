# APP-013 / 3A / P08 — single SDK renewal completed

**SDK command exited 0; one read-only postcheck verified the cached token is valid strictly beyond 2026-11-03 13:30 UTC (8:30 a.m. EST).** No project/role/permission/service qualification request was made. This proves the cached-token prerequisite at the observation time, not fresh provider authorization or that a new token was necessarily issued.

Owner explicitly approved the SDK-managed authentication retry/cache-maintenance exception, one invocation, hidden output, 60-second timeout and one postcheck. Decision committed in governance `c9ab51dc96a131be30c7d9362f81a8448169137e`, record SHA256 `3ceb50b53e9a785aa11739196181f228c249410943e81b0971b7aec4dba7daf5`. Reservation label `renewal-20261103-1300`. Approved window 13:00–13:05 UTC, strict start before 13:02; exact source/executable/21 SDK hashes matched before execution.

## Actual operation and retention

The sequence began **13:01:06.402978 UTC**, ran exactly `/opt/homebrew/bin/gcloud auth print-access-token debynyhan@signmons.com --quiet --verbosity=none` once, and finished **13:01:07.614874 UTC**. Existing strict config preflight passed before the child-only output-control settings were added. stdin/stdout/stderr were directed to the operating system null device; file/HTTP logging, prompts and usage reporting disabled for that child. No raw output, token, expiry or private token/plan file was captured. One exclusive invocation reservation was written before dispatch.

SDK exit code 0; no timeout. The direct parent reaped its owned leader and observed the process group absent. The existing bounded cache reader performed exactly one postcheck and returned VALID_THROUGH_CUTOFF for 13:30 UTC. Its token reference was cleared without claiming secure memory erasure. The SDK's normal credential/cache maintenance was authorized and retained, not rolled back or represented as purged. SDK authentication request count was not observed; it is not asserted to be one or zero. No second CLI invocation, login fallback, browser sign-in, alternate account, new scope/lifetime override or qualification request occurred.

Sanitized immutable attempt/result and receipt verification are in `renewals/20261103-1300/`. A separate receipt/inventory/hash check verified those records without reading the real cache again. No claim of current cache contents beyond the single approved postcheck. No resource/IAM/API/billing/customer/job/payment change, charge, deployment, merge or push.

The initial local executable preflight used a literal resolved-path string and failed: Homebrew's Caskroom path and `/opt/homebrew/bin/gcloud` both resolve through `/opt/homebrew/share/google-cloud-sdk/bin/gcloud`. Subsequent same-file/device/inode comparison and approved byte hash established they are the same executable; no SDK/source pin changed. This was a prelaunch metadata check, not a renewal attempt or retry.

## Handoff

Renewal checklist items 1–4 complete: exact approval/source/clock/config gate, one command, one sanitized validity check, owned-process closeout and receipts. Item 5 prepares a fresh separately approved six-read qualification for November 3, 13:15–13:25 UTC, strict 13:17 start cutoff; it does not execute that qualification.

Credential usability was verified through 13:30 at the postcheck time. Fresh qualification still rechecks the cached token and configuration inside its own authority/window; revocation or drift is not ruled out by this result. Owner must approve that exact new operation. The November 1 operation and this renewal reservation cannot be reused; no SDK exception carries into the six-read no-refresh/no-retry contract.

3A open; accepted 1A/1B/2A/2B **4/8**; R1 newly closed **0/27**. Provider access/roles/API/billing/runtime/payment qualification UNKNOWN. **No scope deviation beyond the expressly approved renewal exception.**

Final local evidence/packet checks: exact source/SDK hashes, renewal receipt hashes/inventory, Python source gate, architecture, backend/governance baseline, docs consistency, 25 governance safeguards and whitespace PASS. Fresh packet validation has five PASS checks; no additional real credential read or provider request was made. No runtime source changed and no old runtime tests are claimed fresh.
