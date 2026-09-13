# Owner-requested execution safeguards

Added root AGENTS.md instructions and a read-only cross-repository gate, scripts/check-governance-baseline.mjs. The governance repository's EXECUTION_SAFEGUARDS.md describes the pinned acceptance-baseline check, CI wiring, mutation tests, limitations and explicit owner-approved rebaseline procedure.

This task is specifically authorized safeguard work, not a new APP-013 section. No scope deviation. No application behavior, provider action, release or milestone acceptance changed. Next product action remains the existing 2B integration contract. Accepted walkthrough: 3/8 (37.5%), not overall MVP.

Validation: combined governance check and 17 regressions; backend bridge success with resolved governance, refusal with missing governance; backend architecture, script syntax and both whitespace checks. No runtime/browser retest claimed because application behavior is unchanged. Review both AGENTS.md files, the pinned checker and mutation tests, and governance CI diff. Required GitHub branch protection/human approval was not configured; code changes still need requirement traceability and review.
