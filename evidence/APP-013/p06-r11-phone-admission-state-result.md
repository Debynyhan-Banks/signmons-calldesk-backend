# P06 / R11 phone-admission-state diagnostic result

Owner-approved read-only operation `bd6a6f3e-6681-4c24-803b-e6ed44248511` reserved once at 14:56:52Z and returned `R11_PHONE_ADMISSION_STATE_DIAGNOSTIC_ACCOUNT_CEILING_EXCEEDED` at 14:57:16Z. The repeatable-read transaction found two valid retained account holds: one staging hold and one controlled hold, totaling 1,000,000 USD micros. Enabled13's exact flow upper bound was 500,000 micros against a 1,000,000-micro account ceiling. Adding the flow would therefore reach 1,500,000 micros and was correctly refused before durable verification reservation or provider invocation.

The current controlled approval was disabled after verified closeout and retained the exact enabled13 digest. There was no packet reuse and no malformed hold row. This excludes the current approval record, packet reuse and ledger corruption as the cause. Existing activation/readback evidence remains authoritative that the approval was active during the browser window.

The operation is consumed and was not retried. It performed no LOGIN change, activation, deployment, traffic change, database write, hold release, ceiling change, provider request/mutation, verification code, browser/customer action, secret/IAM change or billing change.

Governance change request `APP013_P06_R11_PHONE_CEILING_CHANGE_REQUEST.md` presents three owner choices. Recommended alternative 1 retains both liabilities and permits exactly one future packet to use a 1,500,000-micro account ceiling, with no automatic increase or release. No alternative is implemented or authorized by this evidence. P06 remains 12/14 with R11/full R12 open. Original dirty APP-010 checkout preserved. No scope deviation implemented.
