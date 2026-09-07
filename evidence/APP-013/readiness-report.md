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

- Configuration correction is active in staging using the previously approved image.
- The permanent naming and compatibility change is review-only until separately authorized for merge and deployment.
