# Approved solo-owner control amendment

The owner corrected the GitHub identity from Debynyhan to Debynyhan-Banks, then answered yes to explicitly switching both repositories to solo-owner controls. This authorizes removing the separate reviewer requirement, not removing checks or product scope controls.

Old: one separate approving review, required code-owner review, stale-review dismissal and latest-push approval. New: pull-request workflow with zero required approving reviews; no required code-owner/latest-push approval. CODEOWNERS identifies Debynyhan-Banks for informational ownership only. Explicit owner approval in conversation remains required before the agent merges; GitHub cannot independently authenticate that conversation approval.

Preserve strict/up-to-date required checks, administrator enforcement, conversation resolution, no force-push and no branch deletion. Remove the mistaken Debynyhan review request. No application code, provider/release action or steel-thread requirement changes. No scope deviation.

The pinned guard baseline is updated in a separate commit solely for these approved AGENTS.md/CODEOWNERS changes. Approved planning snapshots remain byte-for-byte unchanged. Existing controls-only PRs remain isolated from application work. Merge using a merge commit so the pinned baseline stays in history.
