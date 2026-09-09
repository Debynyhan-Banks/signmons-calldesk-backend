// Explicit local-only integration proof. Creates and drops its own PostgreSQL database.
import assert from "node:assert/strict";
import { verifyCustomerMessagingSettings } from "./verify-customer-messaging-settings.mjs";
import { verifyTechnicianNotifications } from "./verify-technician-notifications.mjs";
import { verifyConversationEmail } from "./verify-conversation-email.mjs";
import { randomBytes, createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { verifyAppointmentConfirmation } from "./verify-appointment-confirmation.mjs";
import { verifyInitialBookingPayment } from "./verify-initial-booking-payment.mjs";
import { verifyJournaledAppointmentBooking } from "./verify-journaled-appointment-booking.mjs";
import { verifyCalendarPendingReview } from "./verify-calendar-pending-review.mjs";
import { verifyCalendarReviewState } from "./verify-calendar-review-state.mjs";
import { verifyCalendarAppliedRecovery } from "./verify-calendar-applied-recovery.mjs";
import { verifyCalendarUncertainRecovery } from "./verify-calendar-uncertain-recovery.mjs";
import { verifyEnqueueRecovery } from "./verify-enqueue-recovery.mjs";
import { verifyAppointmentCancellation } from "./verify-appointment-cancellation.mjs";
import { verifyAppointmentRescheduling } from "./verify-appointment-rescheduling.mjs";
import { verifyCalendarOperationJournal } from "./verify-calendar-operation-journal.mjs";
import { verifyCalendarCreateReconciliation } from "./verify-calendar-create-reconciliation.mjs";
import { verifyCalendarOperationGuards } from "./verify-calendar-operation-guards.mjs";
import { verifyCalendarCreateExecution } from "./verify-calendar-create-execution.mjs";
import { verifyLifecycleCalendarGuards } from "./verify-lifecycle-calendar-guards.mjs";
import { verifyPolicyCalendarGuards } from "./verify-policy-calendar-guards.mjs";
import { verifyLegacyMessageGuards } from "./verify-legacy-message-guards.mjs";
import { verifyLegacyDispatchGuards } from "./verify-legacy-dispatch-guards.mjs";
import { verifyLegacyFieldGuards } from "./verify-legacy-field-guards.mjs";
const require = createRequire(import.meta.url);
const { Client, Pool } = require("pg");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const {
  SmsEnqueueIntentService,
} = require("../dist/communications/sms-enqueue-intent.service.js");
const {
  TransactionalMessagingService,
} = require("../dist/communications/transactional-messaging.service.js");
const {
  TransactionalMessageTemplateService,
} = require("../dist/communications/transactional-message-template.service.js");
const {
  TechnicianWorkflowService,
} = require("../dist/jobs/technician-workflow.service.js");
const database = `calldesk_app013_intents_${randomBytes(6).toString("hex")}`;
assert.match(database, /^calldesk_app013_intents_[0-9a-f]{12}$/);
const local = { host: "/tmp", user: userInfo().username, port: 5432 };
const admin = new Client({ ...local, database: "postgres" });
let prisma,
  pool,
  migrationClient,
  created = false;
try {
  await admin.connect();
  assert.equal(
    (await admin.query("SELECT inet_server_addr() AS address")).rows[0].address,
    null,
  );
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  migrationClient = new Client({ ...local, database });
  await migrationClient.connect();
  const migrations = fileURLToPath(
    new URL("../prisma/migrations/", import.meta.url),
  );
  const directories = (await readdir(migrations, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const migration of directories)
    await migrationClient.query(
      await readFile(`${migrations}/${migration}/migration.sql`, "utf8"),
    );
  await migrationClient.end();
  migrationClient = null;
  pool = new Pool({ ...local, database, options: "-c search_path=public" });
  prisma = new PrismaClient({
    adapter: new PrismaPg(pool, { schema: "public" }),
  });
  const identity = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS database, current_schema() AS schema",
  );
  assert.equal(identity[0].database, database);
  assert.equal(identity[0].schema, "public");
  const tenant = await prisma.tenantOrganization.create({
    data: { name: "Outbox Fixture", timezone: "UTC" },
  });
  const other = await prisma.tenantOrganization.create({
    data: { name: "Other Fixture", timezone: "UTC" },
  });
  const customer = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      phone: "+15555550123",
      fullName: "Synthetic Customer",
    },
  });
  const address = await prisma.propertyAddress.create({
    data: {
      tenantId: tenant.id,
      customerId: customer.id,
      customerTenantId: tenant.id,
      googlePlaceId: "fixture",
      formattedAddress: "Synthetic address",
      addressComponents: {},
      latitude: 0,
      longitude: 0,
    },
  });
  const category = await prisma.serviceCategory.create({
    data: { tenantId: tenant.id, name: "Fixture service" },
  });
  const technician = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: "fixture@example.invalid",
      fullName: "Synthetic Tech",
      role: "TECH",
    },
  });
  const jobData = {
    tenantId: tenant.id,
    customerId: customer.id,
    customerTenantId: tenant.id,
    propertyAddressId: address.id,
    propertyAddressTenantId: tenant.id,
    serviceCategoryId: category.id,
    serviceCategoryTenantId: tenant.id,
    assignedUserId: technician.id,
    assignedUserTenantId: tenant.id,
    status: "ACCEPTED",
    technicianStatus: "ACCEPTED",
    urgency: "STANDARD",
    pricingSnapshot: {},
    policySnapshot: {},
  };
  let queueCalls = 0;
  const deliveryDouble = {
    create: async (input) => {
      queueCalls += 1;
      const idempotencyKeyHash = createHash("sha256")
        .update(input.idempotencyKey)
        .digest("hex");
      return prisma.communicationEvent.upsert({
        where: {
          tenantId_idempotencyKeyHash: {
            tenantId: input.tenantId,
            idempotencyKeyHash,
          },
        },
        update: {},
        create: {
          tenantId: input.tenantId,
          jobId: input.jobId,
          jobTenantId: input.tenantId,
          channel: "SMS",
          direction: "OUTBOUND",
          provider: "TWILIO",
          status: "QUEUED",
          idempotencyKeyHash,
        },
        select: { id: true, status: true },
      });
    },
  };
  const messaging = new TransactionalMessagingService(
    prisma,
    new TransactionalMessageTemplateService(),
    deliveryDouble,
  );
  const intents = new SmsEnqueueIntentService(prisma, messaging, {
    smsDeliveryEnabled: true,
  });
  const links = {
    verify: () => ({
      tenantId: tenant.id,
      technicianId: technician.id,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  };
  const logger = { warn: () => {} };
  const crashAfterCommit = {
    recordDeparture: intents.recordDeparture.bind(intents),
    processOne: async () => {
      throw new Error("simulated process loss after commit");
    },
  };
  const workflow = new TechnicianWorkflowService(
    prisma,
    links,
    crashAfterCommit,
    logger,
  );
  const job = await prisma.job.create({ data: jobData });
  await workflow.update({
    rawToken: "synthetic",
    jobId: job.id,
    action: "on_my_way",
    expectedUpdatedAt: job.updatedAt.toISOString(),
  });
  const pending = await prisma.smsEnqueueIntent.findFirstOrThrow();
  assert.equal(pending.status, "PENDING");
  assert.equal(queueCalls, 0);
  assert.equal(
    (await prisma.job.findUniqueOrThrow({ where: { id: job.id } }))
      .technicianStatus,
    "EN_ROUTE",
  );
  assert.equal(
    await prisma.auditLog.count({
      where: { entityId: job.id, action: "job.technician_en_route" },
    }),
    1,
  );
  const disabled = new SmsEnqueueIntentService(prisma, messaging, {
    smsDeliveryEnabled: false,
  });
  assert.equal(await disabled.processDue(), 0);
  assert.equal(queueCalls, 0);
  // Concurrent workers share the conditional lease; only one queue call wins.
  await Promise.all([
    intents.processOne({ tenantId: tenant.id, intentId: pending.id }),
    intents.processOne({ tenantId: tenant.id, intentId: pending.id }),
  ]);
  assert.equal(queueCalls, 1);
  assert.equal(await prisma.communicationEvent.count(), 1);
  assert.equal(
    (
      await prisma.smsEnqueueIntent.findUniqueOrThrow({
        where: { id: pending.id },
      })
    ).status,
    "QUEUED",
  );
  // Simulate a crash after queue insertion, before intent acknowledgement.
  await prisma.smsEnqueueIntent.update({
    where: { id: pending.id },
    data: {
      status: "PENDING",
      communicationEventId: null,
      nextAttemptAt: new Date(0),
    },
  });
  await intents.processDue();
  assert.equal(queueCalls, 2);
  assert.equal(await prisma.communicationEvent.count(), 1);
  // A failed durable write rolls back both status and its audit.
  const rollbackJob = await prisma.job.create({ data: jobData });
  const broken = new TechnicianWorkflowService(
    prisma,
    links,
    {
      recordDeparture: async () => {
        throw new Error("intent persistence unavailable");
      },
    },
    logger,
  );
  await assert.rejects(() =>
    broken.update({
      rawToken: "synthetic",
      jobId: rollbackJob.id,
      action: "on_my_way",
      expectedUpdatedAt: rollbackJob.updatedAt.toISOString(),
    }),
  );
  assert.equal(
    (await prisma.job.findUniqueOrThrow({ where: { id: rollbackJob.id } }))
      .technicianStatus,
    "ACCEPTED",
  );
  assert.equal(
    await prisma.auditLog.count({ where: { entityId: rollbackJob.id } }),
    0,
  );
  assert.equal(
    await prisma.smsEnqueueIntent.count({ where: { jobId: rollbackJob.id } }),
    0,
  );
  // Job and communication-event tenant boundaries are database enforced.
  await assert.rejects(
    () =>
      prisma.smsEnqueueIntent.create({
        data: {
          tenantId: other.id,
          jobId: job.id,
          templateKey: pending.templateKey,
          stateHash: "0".repeat(64),
        },
      }),
    (error) => error.code === "P2003",
  );
  const otherEvent = await prisma.communicationEvent.create({
    data: {
      tenantId: other.id,
      channel: "SMS",
      direction: "OUTBOUND",
      provider: "TWILIO",
      status: "QUEUED",
    },
  });
  await assert.rejects(
    () =>
      prisma.smsEnqueueIntent.update({
        where: { id: pending.id },
        data: { communicationEventId: otherEvent.id },
      }),
    (error) => error.code === "P2003",
  );
  // Recover an expired lease, but never queue a changed job snapshot.
  const staleJob = await prisma.job.create({ data: jobData });
  await workflow.update({
    rawToken: "synthetic",
    jobId: staleJob.id,
    action: "on_my_way",
    expectedUpdatedAt: staleJob.updatedAt.toISOString(),
  });
  await prisma.job.update({
    where: { id: staleJob.id },
    data: { technicianStatus: "IN_PROGRESS" },
  });
  await intents.processDue();
  assert.equal(
    (
      await prisma.smsEnqueueIntent.findFirstOrThrow({
        where: { jobId: staleJob.id },
      })
    ).status,
    "STALE",
  );
  assert.equal(queueCalls, 2);
  assert.equal((await intents.list(other.id)).length, 0);
  assert.equal(
    Object.hasOwn((await intents.list(tenant.id))[0], "stateHash"),
    false,
  );
  const confirmationChecks = await verifyAppointmentConfirmation({
    prisma,
    intents,
    messaging,
    disabled,
    jobData,
  });
  const recoveryChecks = await verifyEnqueueRecovery({
    prisma,
    intents,
    disabled,
    jobData,
  });
  const cancellationChecks = await verifyAppointmentCancellation({
    prisma,
    intents,
    disabled,
    messaging,
    jobData,
  });
  const reschedulingChecks = await verifyAppointmentRescheduling({
    prisma,
    intents,
    disabled,
    jobData,
  });
  const calendarJournalChecks = await verifyCalendarOperationJournal({
    prisma,
    jobData,
    otherTenantId: other.id,
  });
  const calendarReconciliationChecks = await verifyCalendarCreateReconciliation(
    {
      prisma,
      intents,
      disabled,
      jobData,
      otherTenantId: other.id,
    },
  );
  const guardChecks = await verifyCalendarOperationGuards({
    prisma,
    intents,
    messaging,
    jobData,
    otherTenantId: other.id,
  });
  const executionChecks = await verifyCalendarCreateExecution({
    prisma,
    intents,
    jobData,
    otherTenantId: other.id,
  });
  const lifecycleGuardChecks = await verifyLifecycleCalendarGuards({
    prisma,
    jobData,
    otherTenantId: other.id,
    disabled,
  });
  const policyGuardChecks = await verifyPolicyCalendarGuards({
    prisma,
    jobData,
    otherTenantId: other.id,
  });
  const legacyMessageChecks = await verifyLegacyMessageGuards({
    prisma,
    intents,
    messaging,
    jobData,
    otherTenantId: other.id,
  });
  const legacyDispatchChecks = await verifyLegacyDispatchGuards({
    prisma,
    jobData,
    otherTenantId: other.id,
  });
  const legacyFieldChecks = await verifyLegacyFieldGuards({
    prisma,
    jobData,
    otherTenantId: other.id,
  });
  const initialPaymentChecks = await verifyInitialBookingPayment({
    prisma,
    intents,
    jobData,
  });
  const journaledBookingChecks = await verifyJournaledAppointmentBooking({
    prisma,
    intents,
    jobData,
  });
  const pendingReviewChecks = await verifyCalendarPendingReview({
    prisma,
    jobData,
    otherTenantId: other.id,
  });
  const reviewStateChecks = await verifyCalendarReviewState({
    prisma,
    jobData,
    otherTenantId: other.id,
  });
  const appliedRecoveryChecks = await verifyCalendarAppliedRecovery({
    prisma,
    intents,
    jobData,
    otherTenantId: other.id,
  });
  const uncertainRecoveryChecks = await verifyCalendarUncertainRecovery({
    prisma,
    intents,
    jobData,
    otherTenantId: other.id,
  });
  const messagingSettingsChecks = await verifyCustomerMessagingSettings({
    prisma,
    jobData,
    otherTenantId: other.id,
  });
  const technicianNotificationChecks = await verifyTechnicianNotifications({
    prisma,
    jobData,
    otherTenantId: other.id,
  });
  const emailCaptureChecks = await verifyConversationEmail({
    prisma,
    tenantId: tenant.id,
    otherTenantId: other.id,
  });
  await prisma.tenantOrganization.delete({ where: { id: tenant.id } });
  assert.equal(await prisma.smsEnqueueIntent.count(), 0);
  console.log(
    JSON.stringify({
      result: "PASS",
      migrations: directories.length,
      checks: [
        ...emailCaptureChecks,
        ...technicianNotificationChecks,
        ...messagingSettingsChecks,
        ...uncertainRecoveryChecks,
        ...appliedRecoveryChecks,
        ...reviewStateChecks,
        ...pendingReviewChecks,
        ...journaledBookingChecks,
        ...initialPaymentChecks,
        ...legacyFieldChecks,
        ...legacyDispatchChecks,
        ...legacyMessageChecks,
        ...policyGuardChecks,
        ...lifecycleGuardChecks,
        ...executionChecks,
        ...guardChecks,
        ...calendarReconciliationChecks,
        ...calendarJournalChecks,
        ...confirmationChecks,
        ...cancellationChecks,
        ...reschedulingChecks,
        ...recoveryChecks,
        "isolated local database",
        "atomic status/audit/intent",
        "rollback on intent persistence failure",
        "disabled recovery",
        "concurrent lease",
        "expired lease/ack-loss recovery",
        "one queue event after retry",
        "stale rejection",
        "cross-tenant job and event FK rejection",
        "tenant-bound privacy-safe listing",
      ],
      providerCalls: 0,
    }),
  );
} finally {
  await migrationClient?.end();
  await prisma?.$disconnect();
  if (pool && !pool.ended) await pool.end();
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
  if (created) console.log("Temporary local fixture database removed.");
}
