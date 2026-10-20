# APP-013 / P06-R11 enabled37 runtime-approval stop and verified closeout — 2026-10-09

Owner-approved plan `b219520c-d810-46da-80fe-bf8b7052dee9` is consumed and must never be rerun. Exact preflight matched 16 phone holds / 8,000,000 micros and nine address operations / 900,000 micros. The limited runtime role opened with limit 10 and zero sessions. Activation operation `ebeecacc-7970-4750-b440-8652b7def17c` completed `ACTIVE` with one matching readback audit.

Deployment was reserved once and stopped at `DEPLOY_NO_TRAFFIC`. Revision `signmons-calldesk-staging-app013p06enabled37` was created from immutable image `sha256:0fd8185f496861902bef3bfad76e081aec21b0d573b25ab08de6a340d666b70a` but failed readiness with `HealthCheckContainerError`. Revision-scoped startup logs classify the application failure as `CONTROLLED_INTAKE_STARTUP_FAILURE stage=RUNTIME_APPROVAL` followed by fail-closed application exit.

The separately owner-approved metadata-only diagnostic read only enabled37's `DATABASE_URL` secret reference, never its payload or any other environment value. It proves the revision inherited `signmons-staging-database-url:4`, the shared production database binding, instead of required child `signmons-staging-p06-child-database-url:2`. Activation/readback wrote the controlled approval to the child. The candidate therefore checked a different database and correctly failed closed at `RUNTIME_APPROVAL`. No database query, credential operation or secret payload access was needed.

The target received zero traffic. Read-only Cloud reconciliation shows normal traffic remained 100 percent on `signmons-calldesk-staging-app013dbrot2`, the enabled tag is absent and the disabled tag remains. No deployment readback, R11 ready result, browser journey, provider request, phone hold, address operation, submit or job receipt exists.

Containment is terminal: revocation operation `9f836834-8e81-4573-b2dc-da281cf12cf1` completed `REVOKED` with one matching readback audit; closeout returned `CLOSED` with empty failures. The corrected controller therefore proved the prior normal-revision defect is resolved. No separate closeout check or retry is required.

Local correction is complete: `r10DeploymentSecretUpdate()` returns both `CONTROLLED_INTAKE_SECRETS_JSON=signmons-staging-controlled-intake-material:1` and `DATABASE_URL=signmons-staging-p06-child-database-url:2`; future private adapters must use the complete value. Exact positive, split-binding and shared-production exclusion assertions pass with all 26 focused controller tests. Plan/port interfaces and containment behavior are unchanged. No build, package, deployment or database/provider action occurred; rollback is the two-file revert.

R11/full R12 remain open; P06 remains 12/14 and accepted milestones remain 3/8. Any future journey requires a fresh package and explicit owner approval. No scope deviation.
