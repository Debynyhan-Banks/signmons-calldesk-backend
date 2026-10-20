# APP-013 / 3A / P07 repaired-runtime readiness package preparation

Date: October 20, 2026, Eastern time

## Status

The owner-approved four-secret startup correction is implemented only in a fresh private operation package at `/private/tmp/p07-repaired-runtime-readiness-20261020-prep1`. The package is bound to the owner-selected October 20, 2026, 7:00–8:30 p.m. Eastern review window, with a strict 7:15 start cutoff and October 21 at 7:00 p.m. retirement deadline. No provider or database command was executed. The package has no `owner-approval.json`, attempt or mutation journal; `--run` refuses with `P07_REFUSED_OWNER_APPROVAL_INVALID`. Its local `--check` returns `P07_PREPARATION_CHECK_PASSED_NO_ACTION`.

This is preparation evidence, not live readiness, payment demonstration or 3A acceptance.

## Requirement traceability

- Section: R1-W01 / APP-013 / 3A / P07.
- Criterion served: prepare the isolated zero-traffic runtime needed before one authentic same-job Stripe Sandbox payment can be requested and settled from the exact signed resource.
- Approved change: `APP013_P07_STARTUP_CREDENTIAL_CORRECTION_PROPOSAL_20261020.md`, Alternative 1; four independent candidate-only startup secrets, seven total resource-level secret bindings and 24-hour retirement.
- Repaired application: source `465e12cf7ecf4874ddbd13a34bee60d85fbb02bd`; image `sha256:36f887749947c0b01db683482c081ca663534e7ffe597560b24597f3d46be9da`.
- Role fixture: exact repository SHA-256 `35785d3857f6fc9b01042d6dee3137eebb18950601fb1b8e7644e340be8fb83c`.

## Prepared package

- Plan `139a3a66-ae17-420d-b18e-7075541e457b`.
- Packet `6afbeebc-373b-4ae4-a552-c1a1ab673730`.
- Operation `f8aa3170-6ac9-4b09-96d9-cc0b688fae0c`.
- Exact candidate revision/tag: `signmons-calldesk-staging-app013p07atomic1` / `app013-p07-atomic`, zero normal traffic.
- Dedicated role: `p07_payment_runtime`, exact fixture plus database CONNECT, six-connection maximum, live-window expiry and mandatory NOLOGIN/zero-session closeout.
- Dedicated service identity: `signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com`, no project role or service-account key.
- Six new secret resources: P07 database URL, disabled Stripe destination webhook secret, disabled OpenAI placeholder, candidate-only admin token, conversation key and technician-link key. The existing Stripe test key is referenced at numeric version 1.
- Seven resource-level Secret Accessor bindings. Deployment uses replacement `--set-env-vars` and `--set-secrets` maps, then refuses any inherited environment key. Twilio, Resend, controlled intake, webchat tools, scheduling, messaging, staging phone and background workers remain disabled/absent.
- Exact six-event connected-account destination contract, initially disabled with zero delivery attempts. Checkout, test-event generation/resend and normal traffic are excluded.
- Persistent sanitized mutation journal is written before every provider mutation, enabling a fresh cleanup-only process to close the role, remove the tag, disable discovered numeric versions, remove attempted bindings and disable the service identity. Stripe mutation uncertainty is journaled before the browser step and requires an absence/disabled/deleted receipt.
- Results name the failed stage, `possibleMutation`, containment failures and no-retry state. Success is only `P07_REPAIRED_RUNTIME_READY_DISABLED` and retains the fixed retirement deadline.

## Local validation

- Python syntax: passed.
- Node syntax for database closeout, Firebase read and IAM `testIamPermissions` helpers: passed.
- Focused controller suite: **29/29 passed**. It covers exact resources/hashes, immutable approval-source binding, disabled/no-window refusal, exact selected-window binding, exact approval, window/retirement bounds, exclusive receipt creation, command failure/timeout sanitization, absence uncertainty, Cloud/database preflight shapes, exact job/account binding, four independent startup values, role attribute/membership/ownership readback, seven resource bindings, exact environment replacement, inherited-environment refusal, disabled destination/event contract, persistent mutation recovery, persistence failure before provider access, interruption containment and cleanup coverage.
- Installed CLI help confirmed Cloud Run replacement environment/secret flags, no-traffic/tag/revision controls and unconditional secret IAM bindings. It also disproved the originally drafted `gcloud iam service-accounts test-iam-permissions` command; the package now uses the read-only IAM REST `testIamPermissions` method through the existing explicit-token seam. That correction was completed before binding or external action.
- Static secret-pattern scan: no Stripe API key or webhook signing-secret value in package sources.
- Private directory mode: 0700; generated receipt mode: 0600.
- Manifest SHA-256: `6f3b4e1a66962d64248fab185d6388c1d2e78e68dd280d839cc57d412af5ae69`.
- Controller SHA-256: `e1f8fe898ae299f354f8b728afc90407ef0d0b1e6487768deaeaff4fce31258f`.
- Test SHA-256: `e589484982a76df6223e144092cb6546ce565d3ae2ca5be29964be913a19ab31`.
- Binding SHA-256: `c5eb72c440ecc1c840b94c4b25a304f0e3ffb74d553dd1c62350166bab111d8e`.

## Remaining and next observable result

The package is exactly bound and locally verified. Debynyhan Banks next approves or refuses `APP013_P07_REPAIRED_RUNTIME_READINESS_OPERATION_PROPOSAL_20261020.md` before the strict 7:15 p.m. cutoff. No external action begins until that separate exact approval. On approval, the next observable result is `P07_REPAIRED_RUNTIME_READY_DISABLED` or a named stop with mandatory containment.

Accepted progress remains **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. **No scope deviation from the owner-approved startup correction.**
