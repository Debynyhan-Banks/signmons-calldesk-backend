# Private phone input fix — 2026-09-12

Owner approved fixing test-runner input before another attempt. New private-phone-input.mjs accepts ten-digit US numbers, eleven digits starting 1, or +1, including common punctuation/spacing; rejects other country codes, extensions, invalid NANP digit shapes and non-approved suffix. Normalizes once to E.164, asks private YES confirmation, permits at most three invalid-entry attempts, distinguishes cancel/timeout/unavailable. Existing suffix allowlist retained; this is not independent phone ownership proof.

Runner calls collection before gcloud token access, IAM mutations or propagation wait; passes the same confirmed in-memory value to the live module, which revalidates it. No phone value, OTP or credentials logged/committed. OTP dialog now distinguishes cancellation/timeout too. Fixed historical execution window remains expired; no automatic test restart or external permission granted by this change.

24 local node tests passed for accepted/rejected formats, retry cap, destination guard, confirmation, cancel/timeout/error handling and entrypoint ordering. Both runner syntax checks and whitespace passed. Native dialog runner mocked in tests; no new live Mac dialog/browser QA or full server tests claimed. Server runtime, schema, dependencies and deployed image unchanged, so application lint/build/architecture gates are not applicable to these standalone operational scripts. No IAM, identity, database, deployment or SMS action this run.

Next supervised attempt should first confirm private input, then use a freshly reviewed execution window. No further input-format prerequisite remains in code; actual native interaction still needs exercising. APP-013/2B Now; walkthrough 3/8 (37.5%) unchanged.
