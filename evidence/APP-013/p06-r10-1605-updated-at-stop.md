# P06 / R10 4:05 PM updatedAt stop

## Result — 2026-09-19

Owner-approved plan `7fdf7e8c-397b-46a2-9ecf-86e45f20a424` opened bounded LOGIN with zero sessions and expiry at 4:35 PM Eastern. The connected run exclusively reserved activation at `2026-09-19T20:16:18.583Z`.

The repaired private evidence returned `ACTIVATION_UPDATED_AT`: the locked tenant row's broad `updatedAt` value no longer matched the snapshot read immediately after reservation. The transaction stopped before comparing the controlled runtime/phone approval pair and before any activation update or audit. No activation result, deployment reservation or deployment result exists.

Mandatory containment returned `closeoutStatus: CLOSED` at `2026-09-19T20:16:21.490Z`. The consumed operation was not retried. No deployment, provider request, verification code, address request, browser journey, reviewed submission, job or customer contact occurred.

This second observed timestamp stop demonstrates that the full tenant-row timestamp is not a stable pre-transaction activation authority boundary. The narrow proposed change is to snapshot and compare only the two controlled approval values before activation, while preserving the locked-row status/current-policy checks, exact approval-digest checks, in-transaction `updatedAt` compare-and-set update, audit write, rollback and no-retry behavior. This is a material change to the previously reviewed activation input and requires owner approval before implementation.

P06 remains 11/14 with R10/R11/R12 open. Original dirty APP-010 checkout preserved. No scope deviation implemented.
