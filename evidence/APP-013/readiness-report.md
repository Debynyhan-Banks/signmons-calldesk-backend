# APP-013 Review Checkpoint - Communication Availability Boundaries

Date: 2026-09-07

## Bounded scope

- Signmons inbound voice and SMS transport remains available 24/7.
- Tenant business hours describe human availability and escalation expectations; they do not disable automated intake.
- Outbound SMS quiet hours are now named `outboundQuietHoursStart` and `outboundQuietHoursEnd` so they cannot be mistaken for tenant office hours.
- Existing deployments using legacy `quietHoursStart` and `quietHoursEnd` remain readable during migration.
- Equal outbound quiet-hour bounds mean no suppression and require explicit compliance review before activation.
- Outbound SMS remains disabled in staging.

## Staging correction

- Staging routes 100 percent of traffic to revision `signmons-calldesk-staging-be008bounds`.
- Liveness and database readiness returned HTTP 200.
- Unsigned Twilio voice requests fail closed with HTTP 401.
- Inbound voice and SMS remain available 24/7.
- The independent recipient-local outbound SMS quiet window is 9 PM to 8 AM.

## Validation

- Focused configuration and communications tests: 55 passed.
- Full test suite: 34 suites passed, 1 existing suite skipped; 280 tests passed, 3 existing tests skipped.
- Build: passed.
- Lint: passed.
- Architecture check: passed.
- Diff check: passed.

## Release disposition

- PR `#18` merged at `b6f1d13fb798e115eb7e8365a416a8fe07fe6123`.
- Cloud Build `a3f8fa04-5753-443d-b3e8-c4ba3b151536` produced immutable image digest `sha256:37286933d882466b8592120f48eb69c34e14cdb5a23c1f37480e39a1e6ff933a`.
- Cloud Run revision `signmons-calldesk-staging-app013bounds` passed zero-traffic liveness, readiness, unsigned voice rejection, unsigned SMS rejection, and outbound-specific configuration checks before promotion.
- The revision now serves 100 percent of staging traffic; routed liveness and readiness return HTTP 200, and the Twilio voice/SMS webhook URLs still match exactly.
- Inbound voice and SMS remain available 24/7. The separate outbound quiet window is 9 PM to 8 AM recipient-local, and outbound SMS remains disabled.
- The temporary build service account was disabled after release and retains zero project, Artifact Registry repository, and Cloud Build bucket roles.
