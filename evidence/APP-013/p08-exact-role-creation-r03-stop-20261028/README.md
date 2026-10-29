# APP-013 / 3A / P08 — HTTPS-corrected exact role-creation R03 stop

Approved operation `d45f0618-c8a9-4c85-910a-c60c9352e9cc` started once at 8:40 p.m. Eastern on October 28, 2026, from backend `a64e933`. The active owner, exact project, memory-only bearer, project policy and dedicated-identity policy reads completed. The strict projected-policy parser rejected the dedicated-identity policy at fixed stage `CLI_5_IDENTITY_POLICY` with reason `ROLE_DRIFT` and safe category `UNKNOWN`.

No HTTPS request, role GET or create request occurred. The controller recorded `createdCount: 0` and `unknownCount: 0`; therefore no provider mutation was attempted and the contingent ownership closeout was unnecessary. The attempt was consumed and was not retried.

Both mode-0600 private inputs were deleted with absence readback. The controller exited and process readback found no `role_provisioner.py` or matching gcloud process. Containment is verified. Raw policy output was not retained. The private sanitized attempt/result SHA256 values are `fc6efa26178cfdf9adbeff88ffd503b479ce5b4fca4f492024efba89bd46c552` and `71fee704aceb312f11c443c74e8e88f2856b369634f42569362872947aed130a`.

No accepted milestone or R1 ledger row changes. The demonstrated gap is limited to the strict projected-policy parser's handling of the dedicated identity's projected-policy representation; the exact rejected shape remains unknown because raw output was not retained. Any parser correction or new external operation requires prior owner approval. **No scope deviation.**
