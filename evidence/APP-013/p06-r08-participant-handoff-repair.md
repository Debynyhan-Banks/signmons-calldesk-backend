# P06 / R08 private participant-input handoff repair

## Bounded section card — 2026-09-18

- Approved section: APP-013 / P06 / R08, existing delivery-bundle preparation. This does not add a task or alter the frozen 14-item denominator.
- Acceptance criterion advanced: bind the one owner-confirmed private participant to the reviewed controlled-phone packet using the exact E.164 phone HMAC, numeric digest-key version and account identifier, without persisting or displaying the phone and without granting send, activation or R10 authority.
- Inspected missing-behavior evidence: `/Volumes/Signmons-P06/r08-bundle-preparation-20260918/README.md` records a stopped binding with no `participant-binding.json`; directory inspection confirms no binding or bundle. The wrapper performed local preflight in one child, then collected private input and started a second child without waiting for that child's preflight-ready signal. Existing diagnostic records are fixed-field negative-test records and do not establish a participant attempt or root cause.
- Connected workflow: the resulting HMAC is the participant identity input required by the existing U01 runtime envelope before an R08 delivery bundle can be reviewed. It cannot start or check verification, send a code, activate intake or authorize the R10 controlled run.

### Source, reuse and exact change

- Entry source: backend `db0be034f72ee21b577b55edbe3f572ff3b6ddc3`; governance `eaf63ccacec49525d11e90795cbe2378fe7a7181`.
- Reuse: the bounded READY-line reader, hidden bytearray TTY capture, signal handling, terminal restoration and anonymous-pipe handoff pattern already covered by `scripts/p06_private_input.py` and `scripts/test_p06_private_input.py`; the child continues to use `scripts/p06_backup_guards.mjs::readPipe`, `scripts/p06-runtime-packet.mjs::googleSecretPorts` and existing storage/build checks.
- Expected interfaces/files: tracked wrapper `scripts/p06_private_participant.py`; focused tests `scripts/test_p06_private_participant.py`; prepared copies of the wrapper and binder under the existing encrypted R08 preparation directory; this evidence record. The binder will emit exactly `READY\n` only after its local source/build/storage/no-existing-binding preflight, then accept one FIFO line. Its terminal result remains exactly `PARTICIPANT_BOUND_NO_SMS\n` or an allowlisted fixed failure stage.
- No application route, module, schema, runtime configuration, policy, provider adapter or deployment artifact changes.

### Data, state, identity and retention boundaries

- Input: one hidden US E.164 value, `+1` plus ten digits, read from a real controlling terminal with a 60-second bound. It is held in a bytearray, forwarded once through child stdin, and overwritten on success, refusal, signal and timeout paths.
- Child boundary: same-process preflight precedes `READY`; the parent does not prompt before `READY`. Child stdin must be FIFO. The binder may access only digest-key version 1 and account-SID version 1 after valid private input. It has no upload reservation and no Twilio, Address Validation or database call.
- Persistence: exclusive mode-0600 `participant-binding.json` may contain only source revision, participant label, purpose, numeric source references, participant HMAC, nonsecret account identifier and bound timestamp. No phone, key, token, access token, raw exception or response body may be written or printed.
- Identity: fixed owner participant, fixed Signmons account suffix, fixed project/resource references and clean source/build hashes. No request-supplied identity or resource path.
- Retention/recovery: existing preparation directory and encrypted-volume rules remain. An existing binding is a stop; no overwrite or automatic retry. Diagnostic output remains fixed-stage/status only. The expired September 18 09:25–09:40 Eastern plan is not renewed or reused.

### Finite implementation and verification checklist

1. Replace the split check/prompt/bind wrapper with one bind child that emits bounded `READY` after its own local preflight.
2. Reuse hidden bytearray capture, exact phone-format validation, anonymous pipe forwarding, zeroing, terminal restoration and bounded child cleanup.
3. Expand fixed diagnostic parsing to every emitted binder stage; never surface raw child output.
4. Keep `--check` read-only and prevent check/negative harness activity from being represented as a participant attempt.
5. Run focused positive transport, invalid input, partial/wrong READY, child refusal, non-TTY, timeout and signal-cancellation tests with a synthetic local child; assert terminal restoration, FIFO stdin and no phone disclosure/persistence.
6. Run the actual prepared binder's local `--check`; no secret payload access, participant input or provider call.
7. Run relevant existing private-input/runtime-packet tests, build/lint/architecture, governance baseline/consistency/regressions and both whitespace checks.

### Dependencies, exclusions, rollback and finish

- Dependencies/approval owners: the owner must personally enter the participant phone for the eventual real binding. Any secret payload read during that real binding and any later bundle upload require the existing R08 authorization boundary. A new prepare window must be separately fixed after the expired plan. R10 activation/paid verification remains separately gated.
- Exclusions: no bootstrap replay, credential/provisioning/R09 repetition, runtime LOGIN, intake activation, verification code, bundle upload, deployment, IAM/secrets mutation, payment, customer contact or acceptance-count change.
- Rollback/disabled state: restore the prior prepared wrapper/binder copies; absence of `participant-binding.json` leaves the flow disabled and incomplete. Application/runtime state is unchanged throughout this repair.
- Observable finish: synthetic process-level transport suite and actual local `--check` pass; no participant binding or bundle exists; prepared command is ready for a fresh owner retry. Evidence must distinguish synthetic diagnostics from any future owner attempt and report no scope deviation.

## Result

Implemented the fixed same-child handshake in tracked operator sources. The wrapper now starts the exact bind child, waits for the child's complete bounded `READY\n` after local preflight, captures the phone with echo/canonical/signal handling disabled, validates the exact US E.164 shape, writes it once to the child's FIFO stdin, overwrites the bytearray and accepts only fixed success/failure output. The binder labels future bind failures `participant-attempt`; `--check` cannot create an attempt diagnostic. Historical unlabelled diagnostics remain unchanged and are not reclassified as owner attempts; the preparation record confirms synthetic negative tests contributed diagnostic records.

Local validation before prepared-copy installation:

- 6 new process-level participant tests pass: positive TTY-to-FIFO transfer, invalid-format refusal, fixed child-stage propagation, wrong/partial/preflight READY refusal before prompt, SIGTERM cleanup/terminal restoration and non-TTY refusal. The synthetic phone is absent from captured stdout, stderr and PTY output.
- 12 existing private-input tests pass.
- 35 focused Node operator tests pass with 2 existing local-PG skips, covering runtime packet/bundle boundaries, private pipe, backup and role-password paths.
- Backend build, lint, architecture, formatting, syntax and whitespace checks pass.
- Frozen baseline, cross-repository consistency, backend governance bridge and 21 governance regression tests pass.

The tracked wrapper and binder were installed byte-for-byte as mode-0600 files in the existing encrypted preparation directory. Its build binding was advanced to the focused clean source commit; all 713 compiled-file hashes remained exact. The first sandboxed check refused only because macOS DiskManagement/Time Machine metadata was unavailable inside the sandbox. The identical command with read-only host metadata access returned exactly `LOCAL_CHECK_PASSED_NO_ACCESS`. This check did not prompt, access a secret payload, create an attempt diagnostic, contact a provider or mutate state.

No `participant-binding.json` or delivery-bundle result exists. The September 18 09:25–09:40 Eastern planning window expired and was not extended. The repaired command is ready for a fresh owner retry of participant binding only; later bundle authorization must use a new bounded prepare window. P06 remains 10/14 complete with R08/R10/R11/R12 open. No scope deviation.

## First owner retry and transport closeout

The owner reported `participant binding stopped`. One new fixed diagnostic at 2026-09-18T15:49:41.381Z is explicitly `recordKind: participant-attempt`, stage `INPUT_PIPE`, no HTTP status and `noSms: true`. The child had passed local preflight/READY but did not reach `INPUT_FORMAT`, Google authentication or either secret read. No binding or bundle exists. The diagnostic cannot distinguish a child pipe failure from a parent-side local format refusal, cancellation or prompt timeout because all three previously closed stdin and the child recorded EOF as `INPUT_PIPE`; do not infer that a correct phone reached the child.

Closed that ambiguity within the same R08 repair card. Parent-side format refusal, cancellation and timeout now send a fixed `ABORT` frame; the child acknowledges it without creating a participant-attempt diagnostic or accessing Google. The parent prompt remains bounded at 60 seconds, while the child pipe wait is 65 seconds so cleanup cannot lose the deadline race. Exact production `readPipe` is now exercised behind the real PTY/FIFO wrapper in addition to the prior synthetic reader.

Follow-up validation: 7 participant-handoff tests and all 12 existing private-input tests pass (19 total), including production `readPipe`, local abort acknowledgement, positive transfer, invalid input, wrong/partial READY, fixed child refusal, non-TTY refusal, signal cleanup, no synthetic-phone output and terminal restoration. The newest tracked wrapper/binder were reinstalled byte-for-byte as mode-0600 files, the clean source/build binding was advanced without compiled-file drift, and the actual read-only prepared check again returned `LOCAL_CHECK_PASSED_NO_ACCESS`. No provider, secret payload, SMS, activation, deployment, login or IAM action occurred. No scope deviation.

## Second owner retry stopped locally

The owner again reported `participant binding stopped`. No new child diagnostic exists after the prior 2026-09-18T15:49:41.381Z record, and no participant binding or bundle exists. This proves the fixed `ABORT` frame was received and acknowledged: the second stop was local to hidden-input capture (format, timeout or cancellation), not child preflight, pipe parsing, Google authentication or secret access. That wrapper revision displayed the local stage in Terminal but did not persist it, so the exact one cannot be reconstructed afterward.

Closed the remaining local-observability and Terminal-paste gap. Exact bracketed-paste wrappers `ESC[200~...ESC[201~` are now accepted only when they enclose an otherwise exact `+1` plus ten-digit value; every other control sequence or malformed value still refuses before the child receives participant data. Local format, timeout and cancellation stops now write an exclusive mode-0600 fixed-field `local-input-stop` record containing only kind, stage, noSms and timestamp. No phone, length, bytes, exception or terminal content is retained.

Nine participant-handoff tests plus the 12 existing private-input tests pass (21 total), including exact production `readPipe`, typed and bracketed-paste success, fixed private phone-free local diagnostic, abort acknowledgement, invalid input, wrong/partial READY, fixed child refusal, non-TTY refusal, signal cleanup and terminal restoration. The corrected wrapper was installed mode0600, compiled hashes remained exact after clean-source rebinding, and the actual read-only prepared preflight returned `LOCAL_CHECK_PASSED_NO_ACCESS`. No scope deviation.

## Third owner retry identified exact local format refusal

The owner again reported `participant binding stopped`. One new mode-0600 `local-input-stop` record at2026-09-18T16:06:49.915Z contains only `INPUT_FORMAT`, noSms and timestamp. No new child diagnostic, participant binding or bundle exists. The child acknowledged `ABORT`; input did not reach child format parsing, Google authentication or secret access.

The local capture now canonicalizes harmless US-number presentation only: Terminal's exact bracketed-paste wrapper, ASCII spaces, parentheses, hyphens and periods are removed in memory, then the result must still match exact canonical `+1` plus ten digits with a valid NANP leading digit. The raw presentation buffer is overwritten before the canonical value is forwarded. All other characters, country shapes and malformed values still refuse locally and persist only the fixed phone-free stage.

Ten participant-handoff tests plus the 12 existing private-input tests pass (22 total), adding common formatted-US input → exact E.164 pipe proof. The corrected wrapper was installed mode0600, clean-source/build binding remained exact, and the actual prepared read-only preflight returned `LOCAL_CHECK_PASSED_NO_ACCESS`. No scope deviation.

## Participant binding verified

The owner reported `participant bound`. The exclusive mode-0600 `participant-binding.json` was created at2026-09-18T16:17:25.267Z from executed backend source `59f2dabc022e3c9d91a1233aece6d8c67fe6c3b4`. It is551bytes and has exactly eight approved fields: source revision, participant label, R08-only purpose, numeric digest-key reference, 64-lowercase-hex participant HMAC, nonsecret account identifier, numeric account-identifier reference and bound timestamp. Shape/readback confirms the fixed Signmons account suffix. No phone, digest key, token, access token, raw exception or response body is present.

The successful binder accessed only the approved digest-key version1 and account-identifier version1 after local validation, computed the HMAC in memory, overwrote the key buffer and cleared the Google credential. It had no upload reservation or adapter for bundle creation and made no Twilio, verification, Address Validation or database request. The five prior child diagnostic records and two local input-stop records remain historical failure evidence; success created no new failure record.

No delivery bundle/result exists. The September18 09:25–09:40 Eastern plan remains expired with activationAuthorized=false, paidVerificationAuthorized=false and automaticExtensionAllowed=false. Participant binding is complete within R08; R08 itself remains open for exact final envelope/facts/packet review, a new owner-approved <=15-minute prepare window and one guarded U01 bundle operation. R10 activation/paid verification remains separately gated. P06 remains10/14 with R08/R10/R11/R12 open. This post-result evidence commit must not rewrite the executed binding's source revision or imply permission to upload. No scope deviation.
