# P06/R11 refusal-category release preparation

Status: decision-ready local preparation only on October 2, 2026. Governance proposal: `APP013_P06_R11_REFUSAL_CATEGORY_RELEASE_PROPOSAL_20261002.md`.

The release candidate starts from deployed source `0a857edcc88a6da36dc6669382a74546173e480b` and applies only the six-file owner-approved refusal repair. Candidate commit `8f27952ceaae4f68d5ea7244ccc9b7dbdbcf6d7f`, tree `2e2087088f8ec4089f6ce528e0f5e617054017d0`; delta six files, 156 insertions, 12 deletions.

Archive `/private/tmp/signmons-refusal-category-release-8f27952.tar.gz` is 1,000,310 bytes with SHA-256 `d8e9e4d5488ca86820497916581c634b8613703996774b7efa3b46b2d0b79250`; independent readback is byte-identical. Its 561 tracked files exclude `.git`, dependencies, compiled output, evidence, temporary/environment files and key material. Tracked modes are standard.

Candidate blobs: journey fixture `acf99dad6520a7abca7f0b66ef4ba127ed8fb51b`; UI verifier `a693cf2db9d2a9d2b726944b525f5d86f2eb2425`; browser-result spec `1538a2d4e1089a3eac89c14b207231ff3fd37433`; browser result `e17ddeaaeae84cbd2b98ffb135cb81923d64b07d`; verification spec `6d65f5e4d2982c4d56e4d17ec752719613ca317d`; verification service `f339e972b4c8b4dbbdb097a7ae25d1fcee17f820`.

All six byte-match the full-harness-tested repair. Candidate focused136, lint, architecture, formatting and build pass. Initial build failed only because a temporary dependency symlink resolved TypeScript types outside the checkout; replacing it with a candidate-local dependency tree made unchanged source pass.

The proposal records exact source/interfaces, end-to-end state/identity/retention boundaries, finite sequence, tests, dependencies, owners, exclusions, rollback and observable finish. Current post-enabled33 balances remain unknown. Expected phone14/USD7.00 and address9/USD0.90 are inference, not readback; a fresh exact gate must stop on unexplained drift.

No external query, build/upload, IAM, image, deployment, allowance, packet, verification message, browser replay or customer/job action occurred. Enabled33 remains consumed. Next boundary is exact owner approval plus a future 75-minute Eastern window. P0612/14; R11/fullR12open; accepted1A/1B/2A3/8. No scope deviation in preparation.
