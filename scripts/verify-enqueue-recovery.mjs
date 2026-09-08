// Invoked inside verify-sms-enqueue-intents.mjs's disposable local database only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  SmsEnqueueRecoveryService,
} = require("../dist/communications/sms-enqueue-recovery.service.js");

export async function verifyEnqueueRecovery({
  prisma,
  intents,
  disabled,
  jobData,
}) {
  const recovery = new SmsEnqueueRecoveryService(prisma);
  const makeFailed = async () => {
    const job = await prisma.job.create({
      data: {
        ...jobData,
        technicianStatus: "EN_ROUTE",
        technicianStatusUpdatedAt: new Date(),
      },
    });
    const captured = await prisma.$transaction((transaction) =>
      intents.recordDeparture(transaction, {
        tenantId: job.tenantId,
        jobId: job.id,
      }),
    );
    const failed = await prisma.smsEnqueueIntent.update({
      where: { id: captured.id },
      data: {
        status: "FAILED",
        attemptCount: 5,
        lastErrorCode: "enqueue_failed",
      },
    });
    return {
      job,
      intent: failed,
      input: {
        tenantId: job.tenantId,
        intentId: failed.id,
        actorId: "synthetic-owner",
        acknowledgeRetry: true,
        reasonCode: "CONFIGURATION_REVIEWED",
        expectedUpdatedAt: failed.updatedAt.toISOString(),
      },
    };
  };
  const first = await makeFailed();
  await assert.rejects(
    () => recovery.retry({ ...first.input, tenantId: randomUUID() }),
    (error) => error.getStatus() === 404,
  );
  await assert.rejects(
    () =>
      recovery.retry({
        ...first.input,
        expectedUpdatedAt: new Date(0).toISOString(),
      }),
    (error) => error.getStatus() === 409,
  );
  const concurrent = await Promise.allSettled([
    recovery.retry(first.input),
    recovery.retry(first.input),
  ]);
  assert.equal(
    concurrent.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    concurrent.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.equal(
    await prisma.auditLog.count({ where: { entityId: first.intent.id } }),
    1,
  );
  const pending = await prisma.smsEnqueueIntent.findUniqueOrThrow({
    where: { id: first.intent.id },
  });
  assert.equal(pending.status, "PENDING");
  assert.equal(pending.attemptCount, 0);
  assert.equal(pending.lastErrorCode, null);
  assert.equal(pending.stateHash, first.intent.stateHash);
  assert.equal(
    await prisma.communicationEvent.count({ where: { jobId: first.job.id } }),
    0,
  );
  await assert.rejects(
    () => recovery.retry(first.input),
    (error) => error.getStatus() === 409,
  );
  await disabled.processOne({
    tenantId: first.job.tenantId,
    intentId: first.intent.id,
  });
  assert.equal(
    await prisma.communicationEvent.count({ where: { jobId: first.job.id } }),
    0,
  );
  // Only this explicit fixture worker call creates a queue record, never a provider call.
  await intents.processOne({
    tenantId: first.job.tenantId,
    intentId: first.intent.id,
  });
  assert.equal(
    await prisma.communicationEvent.count({ where: { jobId: first.job.id } }),
    1,
  );
  const listed = (await intents.list(first.job.tenantId)).find(
    (item) => item.id === first.intent.id,
  );
  assert.ok(listed.updatedAt instanceof Date);
  assert.equal(Object.hasOwn(listed, "stateHash"), false);

  const stale = await makeFailed();
  await prisma.job.update({
    where: { id: stale.job.id },
    data: { technicianStatus: "IN_PROGRESS" },
  });
  await assert.rejects(
    () => recovery.retry(stale.input),
    (error) => error.getStatus() === 409,
  );
  assert.equal(
    (
      await prisma.smsEnqueueIntent.findUniqueOrThrow({
        where: { id: stale.intent.id },
      })
    ).status,
    "FAILED",
  );
  assert.equal(
    await prisma.auditLog.count({ where: { entityId: stale.intent.id } }),
    0,
  );

  const rollback = await makeFailed();
  const broken = new SmsEnqueueRecoveryService({
    $transaction: (callback) =>
      prisma.$transaction((transaction) =>
        callback({
          job: transaction.job,
          smsEnqueueIntent: transaction.smsEnqueueIntent,
          auditLog: {
            create: async (data) => {
              await transaction.auditLog.create(data);
              throw new Error("simulated failure after audit insertion");
            },
          },
        }),
      ),
  });
  await assert.rejects(() => broken.retry(rollback.input), /simulated failure/);
  const unchanged = await prisma.smsEnqueueIntent.findUniqueOrThrow({
    where: { id: rollback.intent.id },
  });
  assert.equal(unchanged.status, "FAILED");
  assert.equal(unchanged.attemptCount, 5);
  assert.equal(
    unchanged.updatedAt.toISOString(),
    rollback.input.expectedUpdatedAt,
  );
  assert.equal(
    await prisma.auditLog.count({ where: { entityId: rollback.intent.id } }),
    0,
  );
  return [
    "retry tenant and timestamp guards",
    "concurrent retry has one reset and audit",
    "retry alone creates no queue event",
    "disabled worker after retry",
    "worker recovery after reviewed retry",
    "stale-state retry rejection",
    "audit failure rolls back intent reset",
    "retry timestamp in privacy-safe listing",
  ];
}
