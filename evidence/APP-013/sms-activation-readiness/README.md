# SMS activation-readiness source reconciliation — 2026-09-12

Planning only. Source baseline c081fb0; governance baseline 4119c4a. Canonical checklist: Signmons governance PILOT_SMS_ACTIVATION_READINESS.md. No new runtime behavior, migration, public policy approval, account inspection or external action.

Verified seams: durable-fixture-sms-consent.ts stores isolated encrypted fixture evidence; communications.module.ts does not register it. customer-messaging-settings.service.ts manages event preferences, not published consent policy. sms-consent.service.ts consumes tenant/phone-hashed live SmsConsentRecord and mutates Customer.consentToText. sms-delivery.service.ts checks consent at creation and before provider send; its queue processor checks smsDeliveryEnabled. These facts establish why fixture records cannot be promoted and why production capture needs a reviewed consent/suppression bridge and all-entry-point send controls.

Next proposed bounded implementation is the tenant policy registry/reader (P1), then reviewed real-consent/suppression integration (P2), with delivery disabled. Controlled activation stays within existing 3C after 2B/3A/3B. Public policy hosting, verified text/effective date, retention/key lifecycle and exact provider/spend/release approvals remain separate. No repeated storage implementation or ninth milestone.

Review: read the governance gap table, P1/P2 exit criteria and owner gate checklist. Previous durable fixture evidence remains in ../durable-fixture-sms-consent/README.md; its 1,917 tests and 14 database checks are historical results, not rerun here. This docs-only section requires governance consistency/placement tests and both repository whitespace checks, not a new backend/UI/browser build claim.

APP-013 remains Now; current workflow milestone 2B; accepted 3/8 (37.5% milestones), not overall MVP completion. No supported calendar ETA.
