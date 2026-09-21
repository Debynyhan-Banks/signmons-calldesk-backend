# P06 / R11 retained-liability refresh result

Owner-authorized read-only operation `27091628-3b8c-493a-ade5-1c1ede40277a` completed once at `2026-09-21T16:50:53.180Z` and returned `R11_RETAINED_LIABILITY_REFRESH_ACCOUNT_CEILING_EXCEEDED`.

The repeatable-read transaction found three valid retained account holds: one staging hold and two controlled holds, totaling 1,500,000 USD micros. Invalid-row count was zero. A future 500,000-micro phone flow would bring retained liability to 2,000,000 micros, above the approved 1,500,000-micro ceiling. Preparation stopped before a new packet was created.

The operation is consumed and must not be rerun. It performed no LOGIN change, activation, deployment, traffic change, database write, hold release, provider request or mutation, verification code, browser/customer action, secret/IAM change or billing change.

Governance change request `APP013_P06_R11_PHONE_CEILING_CHANGE_REQUEST_2.md` presents the next owner decision. P06 remains 12/14 with R11 and full R12 open. Original dirty APP-010 checkout preserved. No scope deviation implemented.
