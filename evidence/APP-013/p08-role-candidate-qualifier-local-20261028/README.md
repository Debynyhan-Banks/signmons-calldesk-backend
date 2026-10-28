# APP-013 / 3A / P08 — local role-candidate qualifier evidence

Owner approved the bounded local preparation in governance commit `0f9197b`, against proposal `6548f05`. This directory contains the disabled qualifier, isolated tests, immutable source manifest and sanitized result.

The qualifier accepts role-list metadata only through an injected adapter. It validates project-scoped canonical role names, active state, unique permissions, duplicate and output caps; distinguishes zero, broader-only, unique and multiple exact candidates; saves at most the two exact candidate IDs and canonical definition hashes; and excludes raw unrelated role metadata from saved output. It enforces source/decision/privacy/deadline/one-attempt bindings, signal-driven child cancellation, concurrency reservation and safe unknown-output classification. Its native entry point is deliberately unbound and returns `P08_ROLE_QUALIFIER_REFUSED_UNBOUND` before any command.

The integration test passes accepted candidates through the unchanged restoration controller's exact IAM plan contract. Eleven isolated tests pass. Synthetic directories and child processes are removed. No Google Cloud request, IAM role or binding action, Firebase action, signing/token, API key action, database action, runtime restoration, Stripe/payment, deployment or spending occurred.

Next observable result requires a separate exact approval: read current Signmons project custom-role metadata once and classify whether zero, one or multiple exact candidates exist for each demonstrated permission gap. **No scope deviation.**
