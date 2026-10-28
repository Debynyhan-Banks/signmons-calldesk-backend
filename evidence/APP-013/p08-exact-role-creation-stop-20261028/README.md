# APP-013 / 3A / P08 — exact stable role-creation stop

Approved operation `ee86cf8f-078d-42da-a4bd-04b95909e32c` started once at 7:20 p.m. Eastern on October 28, 2026, from backend `7650009`. The bound controller completed the active-owner, exact-project and memory-only bearer calls, then the fourth CLI call for IAM service-state metadata exited nonzero. The sanitized fixed reason is `COMMAND_FAILED`; raw stderr and provider bodies were not retained.

No HTTPS request was made. No role GET or create request was attempted, and the controller recorded `createdCount: 0` and `unknownCount: 0`. The operation was consumed and was not retried. Because no mutation request occurred, the contingent read-only ownership closeout was not invoked.

Both mode-0600 private inputs were deleted with absence readback. The controller exited and an escalated process readback found no `role_provisioner.py` or matching gcloud process. Containment is verified. The original sanitized attempt/result SHA256 values are `5f9d45f348ac8c9ee318c29936d6692ec7d9b046a71896ac7adea7971b68a4d8` and `887cc75dcf1ada212cb84cafaecaeb276ee3e5a71542b216b9f20600244390c8`.

No accepted milestone or R1 ledger row changes. A new external read or retry requires a demonstrated-gap proposal and fresh owner approval. **No scope deviation.**
