// Only called in the parent script's disposable local database. All external
// integrations are doubles; no Calendar/provider credentials or network calls.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  AppointmentReschedulingService,
} = require("../dist/scheduling/appointment-rescheduling.service.js");
const {
  SchedulingService,
} = require("../dist/scheduling/scheduling.service.js");
const {
  SmsEnqueueRecoveryService,
} = require("../dist/communications/sms-enqueue-recovery.service.js");

export async function verifyAppointmentRescheduling({
  prisma,
  intents,
  disabled,
  jobData,
}) {
  const config = {
    schedulingEnabled: true,
    schedulingTimeZone: "UTC",
    conversationDataEncryptionKey: "c".repeat(64),
  };
  const logger = {
    error: () => {
      throw new Error("logging unavailable");
    },
  };
  const deferred = {
    recordReschedule: intents.recordReschedule.bind(intents),
    processOne: async () => {
      throw new Error("missed processing");
    },
  };
  let patches = 0;
  let sequence = 0;
  const make = (intentService = deferred) => {
    const rescheduling = new AppointmentReschedulingService(
      prisma,
      intentService,
      logger,
    );
    const scheduling = new SchedulingService(
      prisma,
      {
        enqueueAppointmentRescheduled: () => {
          throw new Error("operations unavailable");
        },
      },
      logger,
      {},
      rescheduling,
      {},
      {},
      config,
    );
    scheduling.fetchBusy = async () => [];
    scheduling.updateCalendarEvent = async () => {
      patches += 1;
    };
    return { scheduling, rescheduling };
  };
  const create = async () => {
    sequence += 1;
    const start = new Date(Date.now() + (sequence + 50) * 86_400_000);
    const end = new Date(start.getTime() + 3_600_000);
    const job = await prisma.job.create({
      data: {
        ...jobData,
        intakeSessionId: randomUUID(),
        calendarEventId: `fixture-${randomUUID()}`,
        serviceWindowStart: new Date(start.getTime() - 86_400_000),
        serviceWindowEnd: new Date(end.getTime() - 86_400_000),
      },
    });
    return { job, start, end };
  };
  const sign = (body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
    return `${payload}.${createHmac("sha256", config.conversationDataEncryptionKey).update(payload).digest("base64url")}`;
  };
  const invoke = (scheduling, fixture) =>
    scheduling.manageAppointment({
      expectedTenantId: fixture.job.tenantId,
      managementToken: sign({
        version: 1,
        purpose: "appointment-management",
        tenantId: fixture.job.tenantId,
        jobId: fixture.job.id,
        expiresAt: Date.now() + 60_000,
      }),
      action: "reschedule",
      slotToken: sign({
        tenantId: fixture.job.tenantId,
        jobId: fixture.job.id,
        start: fixture.start.toISOString(),
        end: fixture.end.toISOString(),
        expiresAt: Date.now() + 60_000,
      }),
    });
  const where = ({ job }) => ({ jobId: job.id, tenantId: job.tenantId });
  const auditWhere = ({ job }) => ({
    tenantId: job.tenantId,
    entityId: job.id,
    action: "appointment.customer_rescheduled",
  });
  const current = ({ job }) =>
    prisma.job.findUniqueOrThrow({
      where: { id_tenantId: { id: job.id, tenantId: job.tenantId } },
    });
  const fixture = await create();
  const { scheduling } = make();
  scheduling.updateCalendarEvent = async () => {
    patches += 1;
    assert.equal(
      (await current(fixture)).serviceWindowStart.toISOString(),
      fixture.start.toISOString(),
    );
    assert.equal(
      await prisma.smsEnqueueIntent.count({ where: where(fixture) }),
      0,
    );
    assert.equal(
      await prisma.auditLog.count({ where: auditWhere(fixture) }),
      0,
    );
    await assert.rejects(
      invoke(scheduling, fixture),
      /needs confirmation by the office/,
    );
  };
  assert.equal(
    (await invoke(scheduling, fixture)).status,
    "appointment_rescheduled",
  );
  assert.equal(patches, 1);
  const finalized = await current(fixture);
  const intent = await prisma.smsEnqueueIntent.findFirstOrThrow({
    where: where(fixture),
  });
  assert.equal(intent.templateKey, "APPOINTMENT_RESCHEDULED");
  assert.equal(intent.status, "PENDING");
  const audit = await prisma.auditLog.findFirstOrThrow({
    where: auditWhere(fixture),
  });
  assert.equal(audit.actorType, "CUSTOMER");
  assert.deepEqual(Object.keys(audit.metadata).sort(), [
    "appointmentLabel",
    "finalizedUpdatedAt",
    "notificationIntentId",
    "previousAppointmentLabel",
  ]);
  assert.equal(audit.metadata.notificationIntentId, intent.id);
  assert.equal(
    audit.metadata.finalizedUpdatedAt,
    finalized.updatedAt.toISOString(),
  );
  assert.equal(
    (await invoke(scheduling, fixture)).status,
    "appointment_rescheduled",
  );
  assert.equal(patches, 1);
  assert.equal(await prisma.auditLog.count({ where: auditWhere(fixture) }), 1);
  await disabled.processOne({
    tenantId: fixture.job.tenantId,
    intentId: intent.id,
  });
  assert.equal(
    await prisma.communicationEvent.count({ where: where(fixture) }),
    0,
  );
  await intents.processOne({
    tenantId: fixture.job.tenantId,
    intentId: intent.id,
  });
  await intents.processOne({
    tenantId: fixture.job.tenantId,
    intentId: intent.id,
  });
  assert.equal(
    await prisma.communicationEvent.count({ where: where(fixture) }),
    1,
  );
  assert.equal(
    (
      await prisma.smsEnqueueIntent.findUniqueOrThrow({
        where: { id: intent.id },
      })
    ).status,
    "QUEUED",
  );
  await prisma.job.update({
    where: { id: fixture.job.id },
    data: { updatedAt: new Date(finalized.updatedAt.getTime() + 1) },
  });
  await assert.rejects(
    invoke(scheduling, fixture),
    /needs confirmation by the office/,
  );
  assert.equal(patches, 1);

  for (const failure of ["intent", "audit"]) {
    const target = await create();
    const failing =
      failure === "intent"
        ? {
            ...deferred,
            recordReschedule: async (tx, input) => {
              await intents.recordReschedule(tx, input);
              throw new Error("after insert");
            },
          }
        : deferred;
    const { scheduling: broken, rescheduling } = make(failing);
    if (failure === "audit") {
      const brokenPrisma = {
        $transaction: (callback) =>
          prisma.$transaction((tx) =>
            callback({
              ...tx,
              auditLog: {
                create: async (args) => {
                  await tx.auditLog.create(args);
                  throw new Error("after audit insert");
                },
              },
            }),
          ),
      };
      const brokenFinalizer = new AppointmentReschedulingService(
        brokenPrisma,
        deferred,
        logger,
      );
      rescheduling.finalize = brokenFinalizer.finalize.bind(brokenFinalizer);
    }
    const previousPatches = patches;
    await assert.rejects(
      invoke(broken, target),
      /needs confirmation by the office/,
    );
    assert.equal(patches, previousPatches + 1); // No Calendar rollback after acknowledgment.
    assert.equal(
      (await current(target)).serviceWindowStart.toISOString(),
      target.start.toISOString(),
    );
    assert.equal(
      await prisma.smsEnqueueIntent.count({ where: where(target) }),
      0,
    );
    assert.equal(await prisma.auditLog.count({ where: auditWhere(target) }), 0);
    await assert.rejects(
      invoke(make().scheduling, target),
      /needs confirmation by the office/,
    );
  }

  const target = await create();
  const { rescheduling } = make();
  const claim = await rescheduling.claim(
    target.job,
    target.start,
    target.end,
    "new fixture window",
  );
  await assert.rejects(
    rescheduling.finalize({ ...claim, tenantId: randomUUID() }, "old", "new"),
    /changed/,
  );
  await assert.rejects(
    rescheduling.finalize({ ...claim, updatedAt: new Date(0) }, "old", "new"),
    /changed/,
  );
  const outcomes = await Promise.allSettled([
    rescheduling.finalize(claim, "old", "new"),
    rescheduling.finalize(claim, "old", "new"),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  assert.equal(await prisma.auditLog.count({ where: auditWhere(target) }), 1);
  assert.equal((await rescheduling.restore(claim, target.job)).count, 0);
  const retryIntent = await prisma.smsEnqueueIntent.findFirstOrThrow({
    where: where(target),
  });
  const exhausted = await prisma.smsEnqueueIntent.update({
    where: { id: retryIntent.id },
    data: { status: "FAILED", attemptCount: 5 },
  });
  const recovery = new SmsEnqueueRecoveryService(prisma);
  assert.deepEqual(
    await recovery.retry({
      tenantId: claim.tenantId,
      intentId: exhausted.id,
      actorId: "synthetic-owner",
      acknowledgeRetry: true,
      reasonCode: "TRANSIENT_FAILURE_REVIEWED",
      expectedUpdatedAt: exhausted.updatedAt.toISOString(),
    }),
    { status: "pending" },
  );
  await prisma.job.update({
    where: { id: claim.id },
    data: { serviceWindowEnd: new Date(target.end.getTime() + 60_000) },
  });
  await intents.processOne({
    tenantId: claim.tenantId,
    intentId: exhausted.id,
  });
  assert.equal(
    (
      await prisma.smsEnqueueIntent.findUniqueOrThrow({
        where: { id: exhausted.id },
      })
    ).status,
    "STALE",
  );
  assert.equal(
    await prisma.communicationEvent.count({ where: where(target) }),
    0,
  );

  const rejected = await create();
  const failed = make().scheduling;
  failed.updateCalendarEvent = async () => {
    throw new Error("unknown Calendar outcome");
  };
  await assert.rejects(invoke(failed, rejected), /could not be confirmed/);
  assert.equal(
    (await current(rejected)).serviceWindowStart.toISOString(),
    rejected.job.serviceWindowStart.toISOString(),
  );
  assert.equal(
    await prisma.smsEnqueueIntent.count({ where: where(rejected) }),
    0,
  );
  assert.equal(await prisma.auditLog.count({ where: auditWhere(rejected) }), 0);
  await assert.rejects(
    rescheduling.claim(
      { ...rejected.job, updatedAt: new Date(0) },
      rejected.start,
      rejected.end,
      "next",
    ),
    /changed/,
  );
  return [
    "reschedule intent only after Calendar acknowledgment",
    "reschedule intent and activity audit atomicity",
    "post-commit reschedule failure isolation",
    "same-window pending/changed replay rejected",
    "finalized reschedule replay without another Calendar call",
    "disabled processing and canonical worker deduplication",
    "reschedule intent/audit rollback without Calendar or window rollback",
    "concurrent single reschedule finalization",
    "reschedule tenant/version guards",
    "late compensation cannot undo reschedule finalization",
    "reviewed reschedule intent retry and changed-window stale rejection",
    "Calendar error captures no reschedule intent",
  ];
}
