# APP-013 / 3A / P08 — normalized exact role-creation R04 stop

Approved operation `743447a5-f14f-4a48-8dd0-f674d024a94c` started once at 9:00 p.m. Eastern on October 28, 2026, from backend `334a7a3`. Five CLI reads completed. Sanitized policy-shape evidence classified the project policy as `NONEMPTY_LIST` and the dedicated-identity projection as `INVALID`; the controller stopped at `CLI_5_IDENTITY_POLICY` with `ROLE_DRIFT` and safe category `UNKNOWN`.

No HTTPS request, role GET or create request occurred. The controller recorded `createdCount: 0` and `unknownCount: 0`; therefore no provider mutation was attempted and the contingent ownership closeout was unnecessary. The attempt was consumed and was not retried.

Both mode-0600 private inputs were deleted with absence readback. The controller exited and process readback found no `role_provisioner.py` or matching gcloud process. Containment is verified. Raw policy output was not retained. The private sanitized attempt/result SHA256 values are `f5edc53d98e77032d3ecfb8874631492fbe27aaf328c0dd25681f2bd39da11ec` and `62a7f17b80e5ecfcb2f8255a706c3f2e79b9a23e8182b96cddb35dd9c7dc98b5`.

No accepted milestone or R1 ledger row changes. The demonstrated gap is limited to the strict projected-policy parser rejecting the dedicated identity's root projection. A root-level null projection is the narrow likely cause, but remains an inference because raw output was not retained. Any correction or new external operation requires prior owner approval. **No scope deviation.**
