# Approved 2B priority policy

Owner approved routine eligible automatic intake using STANDARD priority, existing life-safety escalation handling, unclear-case human review and no automatic dispatch. Governance APP013_2B_IMPLEMENTATION_CARD.md records the decision and required regression matrix against source 81e0f8b.

STANDARD is an operational default, not a diagnosis or verified safety assessment. Reuse existing LifeSafetyService; do not assume non-match means safe or let a later summary erase an earlier customer warning. Preserve operator role guards and separate downstream gates. No code/configuration/provider/database changes or runtime acceptance in this documentation checkpoint.

Remaining: exact service activation and permissible final verification/admission evidence contract, then the existing integrated 2B implementation/test path. No new section or scope deviation; walkthrough stays 3/8 (37.5%), not whole-MVP completion.

Validation: 21 governance regressions, frozen baseline, full consistency, backend architecture/cross-repository guard and whitespace checks passed. Runtime tests/lint/build/browser QA not rerun for documentation-only policy recording.
