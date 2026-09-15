# P06-R02 recovery options comparison

Owner-authorized read-only comparison completed2026-09-15. See governance APP013_P06_RECOVERY_OPTIONS.md for the decision table, primary sources, cost/privacy constraints and four finite qualification steps.

Recommendation: qualify a private logical backup of the existing child rather than replace the migration target with a new root. Not authorization to export inherited private data. First observable result, if direction approved: synthetic PostgreSQL18 archive/restore proof plus exact encrypted-storage/credential/retention proposal. Real export/restore and migration remain separately gated.

Root alternative requires a new root/import or bootstrap; no documented in-place detach path verified. Logical archive preserves database state but not roles or continuous changes; security mapping, full restore proof and writer isolation remain mandatory. Neither option tested live. No provider/customer/database/credential action.

R01 closed, R02-R12 open (11), added0. Accepted5/60 (8.3%), walkthrough3/8 (37.5%); ETA unvalidated. Recovery-method amendment proposed, not implemented. Documentation/architecture/frozen/full consistency/21 regression/whitespace gates; no runtime/build/browser acceptance claim.
