# APP-013 / 3A / P07 isolated release-candidate preparation

October 20, 2026. The qualification blocker `P07_DEPLOYMENT_REQUIRED` was converted into a reviewable backend source artifact without changing any external system.

## Exact source

The backend candidate starts from the recovered 576-file source archive that produced the owner-accepted 2B image `sha256:ac802ed03e70f96dff6e268bbeb6284cd7737492b84972ae572b8609639abe5e`. Its base archive SHA-256 is `8def873d3786480945216c3937306ef4b45f28d28c8edb0e53744c86fc696b36`.

Only these nine reviewed P07 files replace their accepted-image-source versions:

- `src/jobs/job-payment-policy.controller.ts`
- `src/jobs/job-payment-policy.service.ts`
- `src/jobs/jobs.module.ts`
- `src/payments/payment-requests.controller.ts`
- `src/payments/payment-requests.service.ts`
- `src/payments/payment-requests.service.spec.ts`
- `src/payments/stripe-webhooks.service.ts`
- `src/payments/stripe-webhooks.service.spec.ts`
- `src/tenants/organization-payment-policy.spec.ts`

Candidate directory: `tmp/p07-release-candidate-20261020`. The normalized backend archive contains 576 files, is 984,980 bytes and has SHA-256 `6b499c4431a2e10d2fd032d167232bfb710209b9d6fa5056df1de236cc5b8400`. `release-manifest.json` records every included file hash and has SHA-256 `478b0187b10cab6f44587c172ceb76a401ab34be9c5845c89e38da3f78fb180c`. Rebuilding the archives twice produced identical hashes.

No `.git`, environment file, dependency directory, compiled backend output, evidence directory, private receipt, credential or customer record is present in the backend archive. The Dockerfile, lockfile, Prisma schema/migrations, build configuration and all other build inputs are byte-identical to the accepted-image source.

The UI candidate starts from backend repository HEAD `3cf8a9dc53d0282a35e6263a36d749c5b32f8e2e` and overlays only the dispatch page, API helper and P07 browser fixture. Its source archive SHA-256 is `c367894da83b32369f0efd15d6c8213184933b17e1553f668e62747352b1dd01`. The local UI output archive is QA evidence only; it uses the local/default API boundary and is not authorized or suitable for Firebase publication. A later preview build must bind the exact approved candidate origin.

## Validation

- Isolated backend focused payment suites: 4 suites, 65/65 passed.
- Isolated backend full suite: 132 suites passed, one skipped; 2,611 tests passed, three skipped, zero failed.
- Isolated backend lint, build and architecture: pass.
- Isolated UI lint and production build: pass.
- Isolated desktop 1440x1000 and mobile 390x844 browser fixture: pass; stable retry and exact active recovery, no horizontal overflow, zero unexpected errors, one expected synthetic 503 per viewport.

Packaging exposed two local harness conditions and both were resolved without changing product behavior: the browser fixture now selects the visible synthetic error rather than Next's route-announcer alert and connects with a synthetic bearer token when the static build has no dev-auth variables; the copied dependency tree's absolute self-link was rebound inside the candidate before the full suite. The production source delta remains the nine backend files and two UI runtime files already reviewed.

No build upload, Cloud Build, registry write, IAM change, deployment, Stripe destination, secret change, database login/query/write, Checkout, event, payment, booking, message, commit, push or merge occurred. Accepted progress remains **6/60 packages, 4/8 walkthrough milestones and 0/13 fully accepted pilot rows**. **No scope deviation.**
