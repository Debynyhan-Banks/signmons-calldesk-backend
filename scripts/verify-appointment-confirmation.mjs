// Called only by verify-sms-enqueue-intents.mjs inside its disposable local database.
// Calendar, operations notifications and transport are doubles. No credentials read.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  AppointmentConfirmationService,
} = require("../dist/scheduling/appointment-confirmation.service.js");
const {
  SchedulingService,
} = require("../dist/scheduling/scheduling.service.js");

export async function verifyAppointmentConfirmation({
  prisma,
  intents,
  messaging,
  disabled,
  jobData,
}) {
  const config = {
    schedulingEnabled: true,
    schedulingTimeZone: "UTC",
    conversationDataEncryptionKey: "a".repeat(64),
  };
  const logger = { error: () => {} };
  let calendarInsertions = 0;
  await prisma.serviceCategory.update({
    where: { id: jobData.serviceCategoryId },
    data: { name: "COOLING" },
  });
  const makeScheduling = (intentService) => {
    const finalizer = new AppointmentConfirmationService(
      prisma,
      intentService,
      logger,
    );
    const scheduling = new SchedulingService(
      prisma,
      { enqueueAppointmentConfirmed: () => {} },
      logger,
      {},
      messaging,
      finalizer,
      config,
    );
    scheduling.fetchBusy = async () => [];
    scheduling.insertCalendarEvent = async () => {
      calendarInsertions += 1;
      return `synthetic-calendar-${calendarInsertions}`;
    };
    return scheduling;
  };
  const crashAfterCommit = {
    recordConfirmation: intents.recordConfirmation.bind(intents),
    processOne: async () => {
      throw new Error("simulated missed post-commit processing");
    },
  };
  const scheduling = makeScheduling(crashAfterCommit);
  const makeInput = async (offset) => {
    const job = await prisma.job.create({
      data: {
        ...jobData,
        status: "CREATED",
        intakeSessionId: randomUUID(),
        policySnapshot: {
          propertyType: "RESIDENTIAL",
          serviceIntent: "DIAGNOSTIC",
        },
      },
    });
    const start = new Date(Date.now() + (offset + 1) * 86_400_000);
    const end = new Date(start.getTime() + 3 * 3_600_000);
    const payload = Buffer.from(
      JSON.stringify({
        tenantId: job.tenantId,
        jobId: job.id,
        start: start.toISOString(),
        end: end.toISOString(),
        expiresAt: Date.now() + 60_000,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", config.conversationDataEncryptionKey)
      .update(payload)
      .digest("base64url");
    return {
      job,
      start,
      end,
      input: {
        tenantId: job.tenantId,
        jobId: job.id,
        sessionId: job.intakeSessionId,
        slotToken: `${payload}.${signature}`,
      },
    };
  };
  const { job, input, start } = await makeInput(0);
  const result = await scheduling.confirmAppointment(input);
  assert.equal(result.status, "appointment_confirmed");
  const confirmed = await prisma.job.findUniqueOrThrow({
    where: { id: job.id },
  });
  assert.equal(confirmed.calendarEventId, "synthetic-calendar-1");
  const intent = await prisma.smsEnqueueIntent.findFirstOrThrow({
    where: { jobId: job.id },
  });
  assert.equal(intent.templateKey, "APPOINTMENT_CONFIRMED");
  assert.equal(intent.status, "PENDING");
  assert.equal(
    await prisma.auditLog.count({
      where: { entityId: job.id, action: "appointment.initial_confirmed" },
    }),
    1,
  );
  assert.equal(
    await prisma.communicationEvent.count({ where: { jobId: job.id } }),
    0,
  );
  await scheduling.confirmAppointment(input);
  assert.equal(calendarInsertions, 1);
  assert.equal(
    await prisma.smsEnqueueIntent.count({ where: { jobId: job.id } }),
    1,
  );
  await disabled.processOne({ tenantId: job.tenantId, intentId: intent.id });
  assert.equal(
    await prisma.communicationEvent.count({ where: { jobId: job.id } }),
    0,
  );
  await intents.processOne({ tenantId: job.tenantId, intentId: intent.id });
  assert.equal(
    await prisma.communicationEvent.count({ where: { jobId: job.id } }),
    1,
  );
  await prisma.smsEnqueueIntent.update({
    where: { id: intent.id },
    data: {
      status: "PENDING",
      communicationEventId: null,
      nextAttemptAt: new Date(0),
    },
  });
  await intents.processOne({ tenantId: job.tenantId, intentId: intent.id });
  assert.equal(
    await prisma.communicationEvent.count({ where: { jobId: job.id } }),
    1,
  );
  // A changed schedule cannot be recovered as the old confirmation.
  await prisma.smsEnqueueIntent.update({
    where: { id: intent.id },
    data: {
      status: "PENDING",
      communicationEventId: null,
      nextAttemptAt: new Date(0),
    },
  });
  await prisma.job.update({
    where: { id: job.id },
    data: { serviceWindowStart: new Date(start.getTime() + 60_000) },
  });
  await intents.processOne({ tenantId: job.tenantId, intentId: intent.id });
  assert.equal(
    (
      await prisma.smsEnqueueIntent.findUniqueOrThrow({
        where: { id: intent.id },
      })
    ).status,
    "STALE",
  );
  assert.equal(
    await prisma.communicationEvent.count({ where: { jobId: job.id } }),
    1,
  );

  // A real intent insert followed by failure must roll back with the calendar reference.
  const broken = makeScheduling({
    recordConfirmation: async (...args) => {
      await intents.recordConfirmation(...args);
      throw new Error("simulated intent persistence failure");
    },
    processOne: async () => assert.fail("uncommitted intent must not process"),
  });
  const failed = await makeInput(1);
  await assert.rejects(
    () => broken.confirmAppointment(failed.input),
    /needs confirmation by the office/,
  );
  const reserved = await prisma.job.findUniqueOrThrow({
    where: { id: failed.job.id },
  });
  assert.equal(reserved.calendarEventId, null);
  assert.equal(reserved.status, "ACCEPTED");
  assert.equal(reserved.serviceWindowStart.getTime(), failed.start.getTime());
  assert.equal(
    await prisma.smsEnqueueIntent.count({ where: { jobId: failed.job.id } }),
    0,
  );
  assert.equal(
    await prisma.auditLog.count({ where: { entityId: failed.job.id } }),
    0,
  );
  await assert.rejects(
    () => broken.confirmAppointment(failed.input),
    /awaiting finalization/,
  );
  assert.equal(calendarInsertions, 2);

  // Real transaction scope rejects the wrong tenant without changing the held job.
  const finalizer = new AppointmentConfirmationService(prisma, intents, logger);
  await assert.rejects(
    () =>
      finalizer.finalize({
        tenantId: randomUUID(),
        jobId: failed.job.id,
        start: failed.start,
        end: failed.end,
        calendarEventId: "wrong-tenant",
      }),
    /reservation changed/,
  );
  assert.equal(
    (await prisma.job.findUniqueOrThrow({ where: { id: failed.job.id } }))
      .calendarEventId,
    null,
  );
  return [
    "initial confirmation reference/audit/intent atomicity",
    "missed post-commit recovery",
    "confirmation replay and ack-loss deduplication",
    "disabled confirmation processing",
    "changed confirmation rejected",
    "intent failure rolls back finalization and preserves reservation",
    "unfinalized replay rejected",
    "finalization tenant guard",
  ];
}
