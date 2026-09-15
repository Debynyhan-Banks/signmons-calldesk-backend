# P06 item 3 — approved read-only staging schema check

2026-09-14 local / September 15 UTC. Owner explicitly approved private use of `signmons-staging-database-url` version **2** solely for schema/migration metadata, without customer-record reads or database changes. Backend HEAD 41a4777; Prisma inputs unchanged from image source 53037fbd118cc4547061dfaf373c45b20a05962b.

## Result: schema is not ready for this source

- Exact recorded Neon host/database matched privately before connecting; schema `public`.
- `BEGIN READ ONLY`; `SHOW transaction_read_only` returned `on`; local statement timeout 10 seconds; transaction ended with `ROLLBACK`, connection closed.
- Only information_schema metadata and selected `_prisma_migrations` fields queried. No migration logs, customer records, tenant settings or application rows read.
- Expected migrations **26**; successful recorded migrations **13**. **13 missing**, **0 checksum mismatches**, **0 extra completed migrations**, **0 unfinished/unrolled-back records**.
- Expected Prisma models **36**; **14 tables missing**, **1 scalar column missing**. This was table/column presence and migration-checksum comparison, not exhaustive type/index/constraint/trigger/default drift certification. Missing migration records plus missing tables already block qualification.
- Credential was obtained through a captured child-process pipe, used in process memory and never emitted or written to a file. No secret value, connection string or customer data in evidence. Existing pg emitted a future SSL-semantics warning; no TLS configuration was weakened.

## Missing migration records

1. 20260908120000_add_sms_enqueue_intents
2. 20260908180000_add_calendar_operation_journal
3. 20260909190000_add_appointment_email_intent
4. 20260909190000_add_calendar_readback_deadline
5. 20260909200000_extend_appointment_email_events
6. 20260909210000_add_appointment_email_consent_evidence
7. 20260911120000_add_address_operation_liability
8. 20260911130000_add_address_execution_deadline
9. 20260912150000_fixture_sms_consent_evidence
10. 20260912160000_tenant_sms_policy_registry
11. 20260912170000_sms_consent_revision
12. 20260912180000_sms_policy_capture
13. 20260913180000_nullable_property_location

Missing tables: AddressVerificationOperation, AddressVerificationRequest, CalendarOperation, SmsEnqueueIntent, TenantSmsPolicyVersion, TenantSmsPolicyHead, FixtureSmsConsentState, FixtureSmsConsentPrompt, SmsPolicyCapture, AppointmentCancellationSnapshot, AppointmentEmailConsentScope, AppointmentEmailConsentEvidence, AppointmentEmailConsentBinding, AppointmentEmailIntent.

Missing column: SmsConsentRecord.revision. The pending PropertyAddress migration changes nullability of existing columns, so its absence is not counted as missing columns; do not infer that the presence check accepted that requirement.

## Next boundary

Do **not** run `prisma migrate deploy`, mark missing migrations applied, create tables manually or deploy the image on the basis of this inspection. Review all 13 existing SQL files as one staging change set: dependency order, effects on existing data, current constraints, lock/timeout risk, backup/recovery evidence and compatibility with the unchanged baseline application. Some files explicitly limit prior approval to disposable local use. Prepare the exact staging-only migration proposal before requesting execution; do not extend that approval to production, new migrations, new customer data or the paid test. No schema correction is authorized yet.

Existing fixed P06 item 3 now has a demonstrated schema blocker; credential injection and final release review also remain. Item 4 remains the separately approved connected run/acceptance. No additional section/package. Accepted packages **5/60 (8.3%)**, walkthrough **3/8 (37.5%)**, provisional **4–8 weeks plus external waits**, low confidence, unchanged pending migration review. No scope deviation; no database writes, migration, deployment or provider call.

Review: compare the names above with source `prisma/migrations`; source/file checksums matched for the 13 applied records. Local inspection script was `/private/tmp/signmons-schema-readonly.hFPduZ/check.mjs` (contains no credential). Architecture, cross-repository governance, frozen/full consistency, 21 governance regressions and whitespace checks apply to this documentation-only handoff; no new runtime/browser test claim.
