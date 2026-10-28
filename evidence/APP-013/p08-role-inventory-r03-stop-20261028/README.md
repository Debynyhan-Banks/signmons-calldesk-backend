# APP-013 / 3A / P08 — exact role inventory R03 stopped result

Section: R1-W01 / APP-013 / 3A / P08. Acceptance remains open.

Approved operation `02aa2053-4985-487d-b7b8-aaf67d6bfb21` ran once on October 28, 2026, at 6:40 p.m. Eastern against backend `fed5efb`, source SHA256 `b164717be48a45e2c6be86d4c3968d636f028dded95af8d0597d580f9af8083b`, governance approval `b185dc6` and proposal pre-decision SHA256 `a55e975f7582faa32c32070af584cf14ce08758aca703038c7c7ce0311ce9f85`.

The three allowed CLI reads and one exact IAM FULL-view HTTPS read completed. The strict lifecycle parser then returned fixed status `P08_ROLE_QUALIFIER_STOP_OUTPUT_UNKNOWN` with sanitized reason `INACTIVE_ROLE`. Private plan and approval inputs were absent on return. The result records no retained raw response, no retained bearer and no possible provider mutation. The operation is consumed; no retry is authorized.

Google documents that an ALPHA IAM Role omits `stage`, and that role lifecycle stages include DEPRECATED and DISABLED: <https://docs.cloud.google.com/iam/docs/reference/rest/v1/roles> and <https://docs.cloud.google.com/iam/docs/roles-overview>. The existing classifier rejects the whole inventory when any row is deleted or its stage is absent/outside ALPHA/BETA/GA. The sanitized result does not identify which documented lifecycle representation triggered the stop, so exact candidates remain unknown.

Next observable result requires an owner-approved local-only correction that validates documented lifecycle values, normalizes omitted stage to ALPHA, excludes deleted/noneligible rows from candidate classification, retains unknown-value refusal and proves the behavior with isolated tests. Any later provider read requires a new exact operation and approval.

Accepted milestones remain 1A/1B/2A/2B (4/8). R1 newly closed remains 0/27; legacy remains 6/60; intelligence remains 0/13. No scope deviation.
