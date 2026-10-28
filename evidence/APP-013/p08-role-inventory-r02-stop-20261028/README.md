# APP-013 / 3A / P08 — exact role inventory R02 stopped result

Section: R1-W01 / APP-013 / 3A / P08. Acceptance remains open.

Approved operation `9725da4a-51e7-439d-aa79-fe48c62229dc` ran once on October 28, 2026, at 6:30 p.m. Eastern against backend `56b90a7`, source SHA256 `86253263a046e080a7d49cb1e2da6a1b2e39610008bdf428084c780031187856`, governance approval `8c90385` and proposal pre-decision SHA256 `6bd1fb0c3be882003dacffb8b8475df4da6281e8b6bd8a244b7c94225bcdbdec`.

The three allowed CLI reads and one exact IAM FULL-view HTTPS read completed. The strict response parser then returned fixed status `P08_ROLE_QUALIFIER_STOP_OUTPUT_UNKNOWN` with sanitized reason `ROLE_SHAPE`. Private plan and approval inputs were absent on return. The result records no retained raw response, no retained bearer and no possible provider mutation. The operation is consumed; no retry is authorized.

Google's documented IAM `Role` resource includes `etag` in addition to the parser's allowed fields: <https://docs.cloud.google.com/iam/docs/reference/rest/v1/roles>. Since transport completed and parsing stopped at `ROLE_SHAPE`, the demonstrated local contract gap is omission of documented output-only metadata such as `etag` from the strict allowed-key contract. Exact candidate facts remain unknown.

Next observable result requires an owner-approved local-only correction that explicitly accepts and discards documented nondecision metadata while continuing to reject unknown fields, followed by isolated tests. Any later provider read requires a new exact operation and approval.

Accepted milestones remain 1A/1B/2A/2B (4/8). R1 newly closed remains 0/27; legacy remains 6/60; intelligence remains 0/13. No scope deviation.
