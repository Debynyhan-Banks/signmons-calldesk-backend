// Invoked only in verify-sms-enqueue-intents.mjs's disposable local database.
// Calendar/operations/transport are doubles; no credentials or external calls.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  AppointmentCancellationService,
} = require("../dist/scheduling/appointment-cancellation.service.js");
const {
  SchedulingService,
} = require("../dist/scheduling/scheduling.service.js");
const {
  SmsEnqueueRecoveryService,
} = require("../dist/communications/sms-enqueue-recovery.service.js");

export async function verifyAppointmentCancellation({
  prisma,
  intents,
  disabled,
  messaging,
  jobData,
}) {
  const config = {
    schedulingEnabled: true,
    schedulingTimeZone: "UTC",
    conversationDataEncryptionKey: "b".repeat(64),
  };
  const logger = {
    error: () => {
      throw new Error("logging unavailable");
    },
  };
  const deferred = {
    recordCancellation: intents.recordCancellation.bind(intents),
    processOne: async () => {
      throw new Error("missed post-commit work");
    },
  };
  let deletions = 0;
  const make = (intentService = deferred) => {
    const cancellation = new AppointmentCancellationService(
      prisma,
      intentService,
      logger,
    );
    const scheduling = new SchedulingService(
      prisma,
      {
        enqueueAppointmentCancelled: () => {
          throw new Error("operations unavailable");
        },
      },
      logger,
      {},
      messaging,
      {},
      cancellation,
      config,
    );
    scheduling.deleteCalendarEvent = async () => {
      deletions += 1;
    };
    return { scheduling, cancellation };
  };
  const createJob = () =>
    prisma.job.create({
      data: {
        ...jobData,
        intakeSessionId: randomUUID(),
        calendarEventId: `fixture-${randomUUID()}`,
        serviceWindowStart: new Date(Date.now() + 86_400_000),
        serviceWindowEnd: new Date(Date.now() + 90_000_000),
      },
    });
  const invoke = (scheduling, job) => {
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        purpose: "appointment-management",
        tenantId: job.tenantId,
        jobId: job.id,
        expiresAt: Date.now() + 60_000,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", config.conversationDataEncryptionKey)
      .update(payload)
      .digest("base64url");
    return scheduling.manageAppointment({
      managementToken: `${payload}.${signature}`,
      expectedTenantId: job.tenantId,
      action: "cancel",
    });
  };
  const jobWhere = (job) => ({ jobId: job.id, tenantId: job.tenantId });
  const auditWhere = (job) => ({
    tenantId: job.tenantId,
    entityId: job.id,
    action: "appointment.customer_cancelled",
  });
  const current = (job) =>
    prisma.job.findUniqueOrThrow({
      where: { id_tenantId: { id: job.id, tenantId: job.tenantId } },
    });
  const job = await createJob();
  const { scheduling } = make();
  scheduling.deleteCalendarEvent = async () => {
    deletions += 1;
    assert.equal((await current(job)).status, "CANCELLED");
    assert.equal(
      await prisma.smsEnqueueIntent.count({ where: jobWhere(job) }),
      0,
    );
    await assert.rejects(
      invoke(scheduling, job),
      /needs confirmation by the office/,
    );
  };
  assert.equal((await invoke(scheduling, job)).status, "appointment_cancelled");
  assert.equal(deletions, 1);
  assert.equal((await current(job)).calendarEventId, null);
  let intent = await prisma.smsEnqueueIntent.findFirstOrThrow({
    where: jobWhere(job),
  });
  assert.equal(intent.templateKey, "APPOINTMENT_CANCELLED");
  assert.equal(intent.status, "PENDING");
  const audit = await prisma.auditLog.findFirstOrThrow({
    where: auditWhere(job),
  });
  assert.deepEqual(audit.metadata, { notificationIntentId: intent.id });
  assert.equal(audit.actorType, "CUSTOMER");
  assert.equal((await invoke(scheduling, job)).status, "appointment_cancelled");
  assert.equal(deletions, 1);
  assert.equal(
    await prisma.smsEnqueueIntent.count({ where: jobWhere(job) }),
    1,
  );
  assert.equal(await prisma.auditLog.count({ where: auditWhere(job) }), 1);
  await disabled.processOne({ tenantId: job.tenantId, intentId: intent.id });
  assert.equal(
    await prisma.communicationEvent.count({ where: jobWhere(job) }),
    0,
  );
  await intents.processOne({ tenantId: job.tenantId, intentId: intent.id });
  await intents.processOne({ tenantId: job.tenantId, intentId: intent.id });
  intent = await prisma.smsEnqueueIntent.findUniqueOrThrow({
    where: { id: intent.id },
  });
  assert.equal(intent.status, "QUEUED");
  assert.equal(
    await prisma.communicationEvent.count({ where: jobWhere(job) }),
    1,
  );

  for (const failure of ["intent", "audit"]) {
    const target = await createJob();
    const failing =
      failure === "intent"
        ? {
            ...deferred,
            recordCancellation: async (tx, input) => {
              await intents.recordCancellation(tx, input);
              throw new Error("after insert");
            },
          }
        : deferred;
    const { scheduling: broken, cancellation } = make(failing);
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
      const brokenFinalizer = new AppointmentCancellationService(
        brokenPrisma,
        deferred,
        logger,
      );
      cancellation.finalize = brokenFinalizer.finalize.bind(brokenFinalizer);
    }
    await assert.rejects(
      invoke(broken, target),
      /needs confirmation by the office/,
    );
    assert.equal((await current(target)).status, "CANCELLED");
    assert.equal(
      await prisma.smsEnqueueIntent.count({ where: jobWhere(target) }),
      0,
    );
    assert.equal(await prisma.auditLog.count({ where: auditWhere(target) }), 0);
    await assert.rejects(
      invoke(make().scheduling, target),
      /needs confirmation by the office/,
    );
  }

  const concurrentJob = await createJob();
  const { cancellation } = make();
  const claim = await cancellation.claim(concurrentJob, "fixture window");
  await assert.rejects(
    cancellation.finalize({ ...claim, tenantId: randomUUID() }),
    /changed/,
  );
  await assert.rejects(
    cancellation.finalize({ ...claim, updatedAt: new Date(0) }),
    /changed/,
  );
  const results = await Promise.allSettled([
    cancellation.finalize(claim),
    cancellation.finalize(claim),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(await prisma.auditLog.count({ where: auditWhere(claim) }), 1);
  assert.equal(
    await prisma.smsEnqueueIntent.count({ where: jobWhere(claim) }),
    1,
  );
  assert.equal((await cancellation.restore(claim, concurrentJob)).count, 0);
  assert.equal((await current(claim)).status, "CANCELLED");

  const retryIntent = await prisma.smsEnqueueIntent.findFirstOrThrow({
    where: jobWhere(claim),
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
    data: { status: "ACCEPTED" },
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
    await prisma.communicationEvent.count({ where: jobWhere(claim) }),
    0,
  );

  const rejectedJob = await createJob();
  const rejected = make().scheduling;
  rejected.deleteCalendarEvent = async () => {
    throw new Error("calendar result unknown");
  };
  await assert.rejects(invoke(rejected, rejectedJob), /could not be confirmed/);
  assert.equal((await current(rejectedJob)).status, "ACCEPTED");
  assert.equal(
    await prisma.smsEnqueueIntent.count({ where: jobWhere(rejectedJob) }),
    0,
  );
  assert.equal(
    await prisma.auditLog.count({ where: auditWhere(rejectedJob) }),
    0,
  );
  await assert.rejects(
    cancellation.claim({ ...rejectedJob, updatedAt: new Date(0) }, "window"),
    /changed/,
  );
  return [
    "cancellation intent only after calendar acknowledgment",
    "cancellation intent/audit atomicity and post-commit failure isolation",
    "unfinished cancellation replay rejected",
    "finalized replay and worker deduplication",
    "disabled cancellation processing",
    "intent/audit insertion rollback without reopening deleted appointment",
    "concurrent single cancellation finalization",
    "version and tenant guards",
    "late compensation cannot undo finalization",
    "owner-reviewed cancellation intent recovery",
    "changed cancellation becomes stale before queue",
    "calendar failure records no intent",
  ];
}
