-- REVIEW ONLY. No password/login, CONNECT, expiry, target binding or execution approval.
-- Apply only inside a reviewed transaction on the isolated child after collision checks.
CREATE ROLE p06_intake_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10;
GRANT USAGE ON SCHEMA public TO p06_intake_runtime;
GRANT SELECT ON "TenantOrganization", "ServiceCategory" TO p06_intake_runtime;
-- PostgreSQL FOR SHARE/UPDATE requires UPDATE on at least one column.
GRANT UPDATE ("updatedAt") ON "TenantOrganization", "ServiceCategory" TO p06_intake_runtime;
GRANT SELECT, INSERT ON "Customer", "Job", "PropertyAddress",
  "ConversationJobLink", "CommunicationEvent", "AuditLog",
  "AppointmentEmailConsentScope", "AppointmentEmailConsentEvidence",
  "AppointmentEmailConsentBinding" TO p06_intake_runtime;
GRANT UPDATE ("fullName", "updatedAt") ON "Customer" TO p06_intake_runtime;
GRANT UPDATE ("updatedAt") ON "Job" TO p06_intake_runtime;
GRANT UPDATE ("createdAt") ON "AppointmentEmailConsentScope" TO p06_intake_runtime;
GRANT SELECT, INSERT, UPDATE ON "Conversation", "AddressVerificationOperation" TO p06_intake_runtime;
GRANT SELECT, INSERT, DELETE ON "CommunicationContent", "AddressVerificationRequest" TO p06_intake_runtime;
