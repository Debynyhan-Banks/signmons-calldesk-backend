# P06/R11 enabled21 HTTP metadata result

Owner-approved operation `2db28e8e-2d91-420e-8a6d-24d2413596e8` ran once against only Cloud Run request logs for enabled21 and the fixed `2026-09-22T17:23:50Z`–`17:30:20Z` interval. It retained five allowlisted customer-session POST metadata rows and no URL beyond path, headers, bodies, query parameters, phone, code, address, token or application log text.

Exactly one submit reached `/customer-session/submit`. It returned HTTP 409 at `2026-09-22T17:29:46.796419Z` after 2.273183664 seconds. Combined with the earlier zero-job/zero-address-row result, this proves a synchronous current-state refusal before address reservation, Google transport or job creation. It was not a timeout, network loss or unknown database commit.

The request-log metadata cannot distinguish the server's two sanitized pre-address 409 classes: customer-intake state changed versus current verification unavailable. The smallest remaining diagnostic is one exact five-second application-log query that retains only the allowlisted refusal class and minimal timestamp/count metadata. The operation is consumed and was not widened or rerun. P06 remains 12/14 with R11/full R12 open. No scope deviation.
