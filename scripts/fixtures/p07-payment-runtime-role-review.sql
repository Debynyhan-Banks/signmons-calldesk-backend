-- REVIEW ONLY: APP-013/3A/P07 local payment-runtime permission proof.
-- No execution approval, password, LOGIN, CONNECT, membership or live target.
-- The approved disposable harness must refuse a pre-existing role/database,
-- verify its private Unix socket and apply this only to its newly created DB.
-- Preserve p06_intake_runtime and its original fixture/negative proof.
CREATE ROLE p07_payment_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 0
  VALID UNTIL '1970-01-01 00:00:00+00';

GRANT USAGE ON SCHEMA public TO p07_payment_runtime;

-- Current policy/account checks and dispatch timezone relation. FOR SHARE
-- requires UPDATE privilege on at least one column; it is not a tenant-edit grant.
GRANT SELECT ("id", "status", "settings", "stripeConnectAccountId",
  "chargesEnabled", "timezone") ON "TenantOrganization" TO p07_payment_runtime;
GRANT UPDATE ("updatedAt") ON "TenantOrganization" TO p07_payment_runtime;

-- Existing binder selects the full Job scalar row with its Payment relation.
-- Current services also use full scalar Payment/AuditLog RETURNING selections.
GRANT SELECT ON "Job", "Payment", "StripeEvent", "AuditLog"
  TO p07_payment_runtime;
GRANT UPDATE ("policySnapshot", "pricingSnapshot", "updatedAt")
  ON "Job" TO p07_payment_runtime;

-- Existence/count guards only: no calendar payload or mutation permissions.
GRANT SELECT ("id", "tenantId", "jobId", "finishedAt")
  ON "CalendarOperation" TO p07_payment_runtime;

-- Explicit current request columns and Prisma-generated/default columns.
-- No Checkout/resource/refund-detail/transfer INSERT columns are included.
GRANT INSERT ("id", "tenantId", "jobId", "jobTenantId", "status",
  "requestKeyHash", "requestedAt", "destinationAccountId", "amountTotalCents",
  "applicationFeeAmountCents", "currency", "refundStatus", "createdAt", "updatedAt")
  ON "Payment" TO p07_payment_runtime;
-- Request reservation/recovery and signed-event observation union only.
-- Refund observation does not authorize a provider refund transaction.
GRANT UPDATE ("status", "requestKeyHash", "requestedAt", "checkoutExpiresAt",
  "stripeCheckoutSessionId", "stripePaymentIntentId", "stripeChargeId",
  "destinationAccountId", "amountTotalCents", "applicationFeeAmountCents",
  "currency", "refundStatus", "refundAmountCents", "stripeRefundId",
  "refundReason", "updatedAt") ON "Payment" TO p07_payment_runtime;

-- Current createMany and status readback; receivedAt/id support generated defaults.
GRANT INSERT ("id", "tenantId", "stripeEventId", "type", "payload",
  "processingStatus", "receivedAt") ON "StripeEvent" TO p07_payment_runtime;
GRANT UPDATE ("processingStatus", "processedAt", "errorMessage")
  ON "StripeEvent" TO p07_payment_runtime;

-- Actor/tenant/job records are seeded by the disposable administrator first.
-- Composite foreign keys do not require user/tenant creation or REFERENCES grants.
GRANT INSERT ("id", "tenantId", "action", "actorType", "actorUserId",
  "actorUserTenantId", "actorId", "entityType", "entityId", "metadata",
  "traceId", "createdAt") ON "AuditLog" TO p07_payment_runtime;

-- Existing dispatch/routing display includes every scalar of these models.
GRANT SELECT ON "ServiceCategory", "User", "RoutingRule", "ServiceArea"
  TO p07_payment_runtime;
-- Relation identities are needed for Prisma's batched relation fetches/filters.
GRANT SELECT ("id", "tenantId", "userId", "userTenantId", "serviceCategoryId",
  "serviceCategoryTenantId", "isEnabled", "proficiency")
  ON "UserServiceCapability" TO p07_payment_runtime;
GRANT SELECT ("id", "tenantId", "userId", "userTenantId", "type", "startAt", "endAt")
  ON "UserAvailabilityBlock" TO p07_payment_runtime;
GRANT SELECT ("id", "tenantId", "addressComponents", "formattedAddress")
  ON "PropertyAddress" TO p07_payment_runtime;

-- Explicit exclusions, proved through actual denied statements by the harness:
-- no DELETE/TRUNCATE; no Job INSERT/lifecycle/assignment/calendar writes;
-- no identity/tenant/job reassignment, createdAt UPDATE or transfer writes;
-- no StripeEvent payload/identity UPDATE; no AuditLog UPDATE;
-- no adjacent booking, dispatch, message, subscription, ledger or intake writes;
-- no blanket ALL, sequence/function, schema CREATE, DDL or elevated membership.
-- These ACLs are not row isolation or an endpoint action allowlist. Application
-- tenant predicates, role guards, policy checks and signed-resource matching remain
-- required. JSON column privileges cannot restrict policy edits to binding alone.
