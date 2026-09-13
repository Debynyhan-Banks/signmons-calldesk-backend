# 2B automatic admission source mapping

Inspected backend b9d6045 and governance 663d924 after fetch. No runtime change. Governance APP013_2B_IMPLEMENTATION_CARD.md records exact existing browser PENDING_REVIEW enforcement, operator-only context, human-review/USER audit serialization, fixture currentProof persistence, session-lock/receipt restrictions and required location fields.

Concrete finding: customer-intake-continuation.service.ts persistAdmission supplies randomUUID for googlePlaceId and zero latitude/longitude; schema requires all three. Recommended nullable-field proposal needs explicit approval before implementation. It preserves existing real values and permits an honest unknown location; no migration, backfill or production change performed. Automatic service policy, urgency semantics and permitted receipt lifecycle also remain design dependencies, not solved by removing operator guards.

Use the existing 2B path and harness; no new section, provider, demo, IAM, spend, merge or deployment. Proposed schema deviation disclosed before implementation. Walkthrough remains 3/8 (37.5%), not overall MVP completion. Next: owner decision on the narrow schema proposal; do not promise runtime readiness.

Validation: 21 governance tests, frozen baseline, full consistency, backend architecture/cross-repository safeguard and both whitespace checks passed. Runtime tests/lint/build/browser QA not rerun for this documentation-only mapping; no new runtime acceptance.
