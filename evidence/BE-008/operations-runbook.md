# BE-008 SMS Operations Runbook

Date: 2026-09-07

## Activation gate

1. Keep `SMS_DELIVERY_ENABLED=false` during deployment and migration.
2. Verify the environment-specific Twilio identity, HTTPS callback origin, signing token reference, consent hash key reference, and encryption key reference. Never paste secret values into evidence, logs, tickets, or chat.
3. Configure `/webhooks/twilio/sms/status` as the outbound status callback and verify signed sandbox callbacks.
4. Complete one consented sandbox delivery, STOP suppression, START restoration, simulated provider rejection, and dead-letter/replay exercise.
5. Enable delivery only after owner review of the redacted evidence.

## Monitoring and ownership

- Dispatcher, admin, and owner roles may inspect `GET /communications/sms/metrics` and `GET /communications/sms/dead-letters`.
- Only owner and admin roles may invoke replay.
- Initial review thresholds: any ambiguous transport outcome; any dead letter; delivery failure rate above 5% over 15 minutes; or retry queue older than 10 minutes.
- Operations owns first response. Engineering owns provider/API failures, migrations, and callback verification. The tenant owner decides whether an ambiguous event may be replayed.
- Metrics contain counts, bounded error codes, and attempts only—no destination, body, provider identifier, or decrypted content.

## Provider outage

1. Set `SMS_DELIVERY_ENABLED=false` to stop new delivery claims while preserving queued canonical events.
2. Do not replay ambiguous outcomes until the Twilio message log is reconciled; the provider may have accepted a timed-out request.
3. Continue job, booking, and payment workflows without claiming that SMS was delivered.
4. When service recovers, inspect privacy-safe metrics/dead letters, reconcile ambiguous events, then re-enable and process bounded batches.

## Rollback

1. Set `SMS_DELIVERY_ENABLED=false`; this is the first and reversible rollback control.
2. Roll application code back while leaving additive communication columns and enum values in place.
3. Do not down-migrate delivery records during an incident. Retain them for reconciliation and audit.
4. Verify inbound voice/SMS signature handling separately after rollback.

## Credential rotation

1. Disable delivery and pause Console webhook changes.
2. Rotate the Twilio credential in the secret manager and runtime environment; never commit it.
3. Restart the service and verify signed sandbox inbound and status callbacks.
4. Send one explicitly authorized sandbox message and verify its terminal callback.
5. Revoke the prior credential only after the new credential evidence passes, then re-enable delivery.

## Safe replay

- Replay is restricted to a tenant-scoped dead letter and requires a reason plus explicit duplicate-risk acknowledgment.
- Replaying resets delivery state but preserves encrypted content and creates an audit entry.
- A replay request does not itself claim successful delivery; the normal worker and signed provider callback remain authoritative.
