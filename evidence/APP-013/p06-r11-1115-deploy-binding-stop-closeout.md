# APP-013/P06 R11 enabled14 deployment-binding stop and closeout

Section: APP-013/P06/R11. R11 and full R12 remain open; P06 remains 12/14.

Plan `093447e7-c3cb-4db4-bdf2-53088a14729f` opened its bounded database LOGIN and transactionally activated/read back the exact approval. The controller then reserved its one zero-traffic deployment and stopped at `DEPLOY_NO_TRAFFIC`. It automatically revoked/read back the approval and did not proceed to a browser or provider request. The consumed run was not retried.

Static comparison proves the local helper defect. The plan, target revision and origin bind `signmons-calldesk-staging-app013p06enabled14`, but the generated deploy command retained `--revision-suffix=app013p06enabled13`. The installer replaced the prior full revision string but not its shorter suffix. Cloud Run already has immutable enabled13, so enabled14 was never created. The no-action check did not compare the deploy suffix with the plan revision and therefore missed this mismatch.

Owner-run closeout returned `R12_RUNTIME_CLOSEOUT_VERIFIED`. Final closed-state readback passed with runtime LOGIN disabled, connection limit zero, zero runtime sessions, enabled tag absent and baseline traffic at 100% `app013bounds`. Independent Cloud Run readback after closeout confirms enabled13 remains latest Ready, enabled14 is absent, the enabled tag is absent and normal traffic remains unchanged. The closeout result's non-fatal `APPROVAL_UNCONFIRMED` entry is a second local controller defect: containment had already revoked the exact matching approval, but explicit closeout recognizes only `INACTIVE` before its final closed-state normalization. Final status is nevertheless `CLOSED`.

`APP013_P06_R11_DEPLOY_BINDING_CHANGE_REQUEST.md` proposes one bounded local repair: derive and validate the deployment suffix from the reviewed plan and treat the exact matching already-`REVOKED` approval as safely contained during closeout. Focused positive, mismatch, failure-containment and already-revoked closeout tests are required before any new packet. No packet, LOGIN, activation, deployment, provider request, verification code, browser/customer action, secret/IAM change or retry is authorized by this evidence. The consumed plan, commands and one-packet ceiling allowance are not reusable.

No scope deviation implemented.
