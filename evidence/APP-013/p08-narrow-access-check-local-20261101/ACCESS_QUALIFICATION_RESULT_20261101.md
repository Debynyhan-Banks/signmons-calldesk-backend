# APP-013 / 3A / P08 — consumed access qualification and verified closeout

**One approved attempt STOPPED: CACHED_TOKEN_EXPIRED. Zero HTTPS calls. Cleanup verified. No retry.**

Owner said “proceed” to the exact November 1, 2026 10:30–10:40 a.m. EST qualification packet, with strict 10:32 start cutoff. Approval was committed in governance `4c125a9aaa753935dd420189a2ed734ee402902a`. Source commit `8e35617dc178ac8ce757548fac830b0013108ad7`, runtime manifest `dc687b5bc36264c57c75154122d406393d2e3711853332e5e57112c881ec9597`, scope `3b9651755344bfb504e886d62a3647d176eb4396feed75ec0f1910219577b44e` and operation `dff9307d-e7fb-4e5a-873c-22179faf0958` matched the approved packet. No runtime source or approved limit was changed.

## Observed execution

- Final prelaunch comparison at **15:28:55 UTC**: exact source/dependency/executable/committed authority/scope PASS; operation root absent; no credential/provider read yet.
- At **15:30:19 UTC**, exclusively created the exact 0700 root, validated the real version-2 plan with the actual clock and committed approval reader, then wrote only plan.json at 0600. Plan SHA256: `57a71135ca78ae499c208607161f5f994a69b12196e07e75085b2965ceb764fc`.
- Invoked the packet's pinned Python `-I -B .../access_check.py --read` command exactly once. Attempt file timestamp **15:30:31.883508 UTC**, result file timestamp **15:30:31.888561 UTC**. These are filesystem receipt timestamps, not provider timestamps. Process exited with code 2.
- Result: **NARROW_ACCESS_STOPPED / CACHED_TOKEN_EXPIRED**, one cache reservation, zero CLI, zero HTTPS, no native residuals, privateInputsAbsent=true, executionReady=false.
- The unchanged cache boundary reached its parsed expiry comparison and refused because the cached token did not expire strictly after the approved **15:40:00 UTC purge deadline**. The expiry/token was not printed or retained. This result does not distinguish already-expired from insufficient remaining lifetime; it does not justify weakening the cutoff or refreshing/retrying.
- The receipt's externalObservation=true means the externally authorized path was used. It is not evidence that any provider responded; HTTPS count is zero. Current project/roles/permissions/API/billing/runtime/payment facts remain UNKNOWN.

No refresh/login, cache write, provider request or mutation, application/provider SQL, key creation, Firebase/customer/job action, payment, spending, deployment, merge or push occurred. The token was handled only in memory by the approved boundary. References/handles were cleared/closed without a secure memory-erasure claim.

## Independent verification and retention

At **15:31:17.901734 UTC**, after the read process exited, a separate verification process acquired the operation lock exclusively and checked the actual inventoried files. Normal closeout had already run; no second read or independent-closeout command was invoked.

Verified: exact root/file modes and allowed inventory; matching attempt and closeout operation/plan hashes; CLOSED journal, one cache reservation, transportSettled=true; result classification/counts/no residuals; plan.json and journal-next.json absent; all before the 15:40 purge deadline. The failed cache reservation remains journaled rather than converted into a successful credential qualification. Original user configuration/cache was neither copied nor purged.

Sanitized originals remain in the operation root. Byte-identical immutable copies and SHA256s are recorded under `operations/dff9307d-e7fb-4e5a-873c-22179faf0958/`: attempt.json, journal.json, closeout.json, result.json, empty entry.lock and closeout-verification.json. No private plan, raw token, expiry or provider payload is included. Source files and executable remained pinned.

## Readiness and handoff

Completed: owner approval, committed authority/source/clock comparison, single bounded real local-cache attempt, normal closeout, independent absence/lock/inventory verification and sanitized receipts. The operation is **consumed**, even though it stopped before HTTPS. Do not reuse the operation, window, plan, root or approval for another read.

Blocker: cached-token validity did not cover the required deadline. Responsible role: owner/credential custodian for any separately authorized credential renewal; implementer must prepare a fresh exact qualification decision/window after that prerequisite is addressed. This turn authorizes no renewal, login, alternate credential path or retry. No substitute implementation or new subsystem is proposed.

Next observable result: a separately authorized fresh qualification with adequate cached-token validity, or owner deferral. Effective live access and full P08 qualification remain UNKNOWN. APP-013/3A open; accepted 1A/1B/2A/2B **4/8**; newly closed R1 **0/27**; old R10 also remains consumed. **No scope deviation.**

Final closeout documentation checks: backend/governance baseline and docs consistency, architecture, both whitespace checks, sanitized receipt SHA256s and 25 governance safeguards PASS. Original approved runtime/manifests unchanged; earlier 49 synthetic runtime tests were not rerun or represented as new live evidence. Separate AGENTS.md edit remains untouched.
