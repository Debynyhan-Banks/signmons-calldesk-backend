# APP-013 / P06-R11 enabled25 draft refusal and verified closeout

## Evidence and fixed acceptance boundary

Source at run: backend fc274c4, runtime/image source6d8ba54 and immutable imageb2415744…fa9dc; governance ebf8a66. Exact owner-approved plan71afedf5-3a71-4bf9-9a2c-a1229ebe3801 used one connected window7:15–7:30 Eastern September25 and required closeout by7:45. The consumed private directory `/Volumes/Signmons-P06/r11-supervised-run-20260925-0700` remains immutable; no rerun or new packet is authorized.

Saved coordinator reservation11:17:14.036Z and LOGIN result11:17:35.055Z precede activation COMPLETE with ACTIVE readback/one matching audit, enabled25 READY_NO_TRAFFIC and READY_FOR_R11. Baseline app013bounds traffic remained100%, enabled25 zero normal traffic. Owner screenshot explicitly shows Code accepted, the controlled address fields, populated supported category/property/service values and draft error: “Check the draft fields. Find and confirm the test address again if it or coverage changed. No draft was saved.” The screenshot's private name/address/phone data are not copied into this evidence. No admission receipt or job creation is demonstrated.

Owner typed STOP and reported R12_RUNTIME_CLOSEOUT_VERIFIED plus R11_ATTENDED_COORDINATOR_CLOSED_BROWSER_STOP. Saved closeout reservation11:27:59.038Z, revocation READBACK/REVOKED/one matching audit and closeout CLOSED/failures[] independently match shutdown. Existing controller source requires inactive approvals, no enabled tag, runtime role NOLOGIN/connection limit0/zero sessions and normal traffic100% for CLOSED; role disable sets past expiry. No new external query was needed. Post-run provider outcomes/hold totals/job counts were not queried or inferred.

## Bounded source analysis; no repair or retry

The exact displayed browser text occurs only for operation draft with HTTP400 or409 (`scripts/fixtures/customer-intake-journey.js`, lines919–925). The screenshot does not distinguish those statuses. Controlled Preview sends the existing seven-field draft with session token and expected transcript revision; it does not send fixture addressSelection. ZIP and ZIP+4 are both explicitly accepted by the controlled form. The draft endpoint format-validates customerName, phone, address, description and supported enums, then checks current protected session/history revision and scope. It does not perform the address-provider validation used by final controlled submit. Therefore the generic test-address wording does not identify an address failure.

Relevant source: `customer-intake-draft.ts` rejects empty required fields, noncanonical international phone, controls/newlines or overlength values; `customer-consent-browser-transport.ts` draft dispatch requires expectedRevision1–20; `customer-intake-continuation.service.ts` previewDraft checks protected history/current scope. Screenshot confirms supported visible selections and an accepted ZIP format; customerName and exact request revision are not visible. The owner subsequently confirmed that Customer name was not filled in. This establishes a specific blocking input: the unchanged server validator rejects an empty customerName with HTTP400 before preview/session/address admission work. A local synthetic check against the actual compiled validator confirms blank name refuses400 and the same fictional draft with a name passes format validation. No private input or external call was used. The numeric historical HTTP status was not independently queried, but the confirmed input is sufficient to explain this refusal. No further live diagnostic is needed for this finding. The generic address-related error concealed the required-field problem; no code repair was made or approved in this investigation.

Completed: one-command handoff, activation/deployment, owner-visible phone Code accepted and verified runtime closeout. Remaining: complete the correlated eligible-address/reviewed-submit journey with all required fields and full R12 evidence/owner acceptance. The missing-name refusal is explained; it does not prove all later gates will pass. Implementer owns evidence and any separately scoped UI repair proposal; owner controls a future window and any new preparation/execution authorization. No retry or new diagnostic is needed now; the consumed run remains closed. No new mandatory prerequisite or section is added. P06 remains12/14; R11/fullR12 open; accepted1A/1B/2A unchanged. No scope deviation.

## Saved evidence hashes

- coordinator-attempt.json: `f5f988c1219cb884628bdbf030e820ec94a32ee0bdad2c563487894f09c1146e`
- login-result.json: `a2cf1816010c149fa7fc1a2120aad9a3ea270f12be43efa0998d8f50a6399d6b`
- activation-stage.json: `e5bf0c8c6c48326cbc18891bcc13be6aa42afaa126cdf07ef9653dfaae5e6990`
- activation-readback.json: `382c9413ecaf9525ba9f552bcd65fc1e74d338a0f65c728260214e6f14bc0541`
- deployment-readback.json: `008d87e3bab6728991f13e205b14ab795b336e82c4de15e158c1a77891674062`
- r10-run-result.json: `442a89147ab24be6836b3a090bbae3feb42919ce8c5f41b96f2fbbf525db3f2d`
- revocation-readback.json: `59b82b81d028c7370af45d75f01d46155cef5fc58a768acba6fb94731b191b6c`
- closeout-attempt.json: `91b044dde9301ae0264d720f1960887682042fbb4c6bd90e75606b4539f7b7e2`
- closeout-result.json: `c9f2d8e59bbc8b7d547b92650ae9bccec4677052402074f00077d1901233bedf`

Checks: fresh two-case synthetic draft-format probe, backend governance baseline, governance frozen baseline and full cross-repository documentation consistency, 21 governance tests, architecture and both whitespace checks passed. No application source, private consumed artifact, runtime configuration, provider state or retained hold was changed during this analysis.
