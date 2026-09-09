// Parent-owned disposable PostgreSQL only; all delivery dependencies reject use.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  SmsDeliveryService,
} = require("../dist/communications/sms-delivery.service.js");
const {
  SmsEnqueueRecoveryService,
} = require("../dist/communications/sms-enqueue-recovery.service.js");
const {
  transactionalMessageJobSelect,
  transactionalMessageStateHash,
} = require("../dist/communications/transactional-message-state.js");

export async function verifyLegacyMessageGuards({
  prisma,
  intents,
  messaging,
  jobData,
  otherTenantId,
}) {
  const [database] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(database.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(database.address, null);
  let forbiddenCalls = 0;
  const forbidden = () => {
    forbiddenCalls++;
    throw new Error("Forbidden delivery dependency");
  };
  const delivery = new SmsDeliveryService(
    prisma,
    { evaluateOutbound: forbidden },
    { decrypt: forbidden },
    { send: forbidden },
    {},
  );
  const recovery = new SmsEnqueueRecoveryService(prisma);
  const start = new Date(Date.now() + 120 * 86400000);
  const end = new Date(start.getTime() + 3600000);
  const templates = {
    APPOINTMENT_CONFIRMED: "recordConfirmation",
    APPOINTMENT_RESCHEDULED: "recordReschedule",
    APPOINTMENT_CANCELLED: "recordCancellation",
    TECHNICIAN_ON_THE_WAY: "recordDeparture",
  };
  let cases = 0;
  for (const calendarEventId of [null, "", " \t "]) {
    for (const window of [
      { serviceWindowStart: start, serviceWindowEnd: end },
      { serviceWindowStart: start, serviceWindowEnd: null },
      { serviceWindowStart: null, serviceWindowEnd: end },
    ]) {
      const reservationStart = new Date(start.getTime() + cases * 86400000);
      const reservationEnd = new Date(end.getTime() + cases * 86400000);
      const job = await prisma.job.create({
        data: {
          ...jobData,
          status: "ACCEPTED",
          technicianStatus: "EN_ROUTE",
          technicianStatusUpdatedAt: new Date(),
          calendarEventId,
          ...window,
          serviceWindowStart: window.serviceWindowStart
            ? reservationStart
            : null,
          serviceWindowEnd: window.serviceWindowEnd ? reservationEnd : null,
        },
      });
      const input = { tenantId: job.tenantId, jobId: job.id };
      const selected = await prisma.job.findUniqueOrThrow({
        where: { id: job.id },
        select: transactionalMessageJobSelect,
      });
      assert.deepEqual(selected.calendarOperations, []);
      // Departure capture failure rolls back its enclosing job/audit transaction.
      await assert.rejects(
        prisma.$transaction(async (tx) => {
          await tx.job.update({
            where: { id: job.id },
            data: { preferredTimeText: "must-roll-back" },
          });
          await tx.auditLog.create({
            data: {
              tenantId: job.tenantId,
              actorType: "USER",
              actorId: "fixture",
              action: "fixture.rollback",
              entityType: "Job",
              entityId: job.id,
            },
          });
          await intents.recordDeparture(tx, input);
        }),
        /compatible job state/,
      );
      for (const [templateKey, capture] of Object.entries(templates)) {
        cases++;
        await assert.rejects(
          messaging.queue({
            ...input,
            templateKey,
            idempotencyKey: randomUUID(),
          }),
          /current job status/,
        );
        await assert.rejects(
          messaging.queue({
            ...input,
            tenantId: otherTenantId,
            templateKey,
            idempotencyKey: randomUUID(),
          }),
          /not found/,
        );
        await assert.rejects(
          intents[capture](prisma, input),
          /compatible job state/,
        );
        const hash = transactionalMessageStateHash(templateKey, selected);
        const intent = await prisma.smsEnqueueIntent.create({
          data: {
            ...input,
            templateKey,
            stateHash: hash,
            attemptCount: 4,
            nextAttemptAt: new Date(0),
          },
        });
        await intents.processOne({
          tenantId: job.tenantId,
          intentId: intent.id,
        });
        const held = await prisma.smsEnqueueIntent.findUniqueOrThrow({
          where: { id: intent.id },
        });
        assert.equal(held.status, "PENDING");
        assert.equal(held.attemptCount, 4);
        assert.equal(held.communicationEventId, null);
        assert.equal(held.lastErrorCode, "calendar_sync_pending");
        assert.ok(held.nextAttemptAt > new Date());
        const exhausted = await prisma.smsEnqueueIntent.update({
          where: { id: intent.id },
          data: { status: "FAILED", attemptCount: 5 },
        });
        await assert.rejects(
          recovery.retry({
            tenantId: job.tenantId,
            intentId: intent.id,
            actorId: "fixture",
            acknowledgeRetry: true,
            reasonCode: "CONFIGURATION_REVIEWED",
            expectedUpdatedAt: exhausted.updatedAt.toISOString(),
          }),
          /no longer matches/,
        );
        assert.deepEqual(
          await prisma.smsEnqueueIntent.findUniqueOrThrow({
            where: { id: intent.id },
          }),
          exhausted,
        );
        assert.equal(
          await prisma.auditLog.count({
            where: { tenantId: job.tenantId, entityId: intent.id },
          }),
          0,
        );
        const event = await prisma.communicationEvent.create({
          data: {
            ...input,
            jobTenantId: job.tenantId,
            channel: "SMS",
            direction: "OUTBOUND",
            provider: "TWILIO",
            status: "QUEUED",
            attemptCount: 2,
            content: {
              create: {
                tenantId: job.tenantId,
                encryptedRaw: "must-not-decrypt",
                payload: {
                  kind: "transactional_sms",
                  templateKey,
                  lifecycleStateHash: hash,
                },
              },
            },
          },
        });
        assert.equal(await delivery.deliver(job.tenantId, event.id), "QUEUED");
        const heldEvent = await prisma.communicationEvent.findUniqueOrThrow({
          where: { id: event.id },
        });
        assert.equal(heldEvent.attemptCount, 2);
        assert.equal(heldEvent.externalId, null);
        assert.equal(heldEvent.lastErrorCode, "calendar_sync_pending");
        assert.ok(heldEvent.nextAttemptAt > new Date());
        await assert.rejects(
          delivery.deliver(job.tenantId, event.id),
          /not claimable/,
        );
        // No event created by admission/recovery, only the test-owned queued seed.
        assert.equal(
          await prisma.communicationEvent.count({ where: { ...input } }),
          Object.keys(templates).indexOf(templateKey) + 1,
        );
      }
      assert.deepEqual(
        await prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
        job,
      );
      assert.equal(
        await prisma.auditLog.count({
          where: { tenantId: job.tenantId, entityId: job.id },
        }),
        0,
      );
      assert.equal(await prisma.calendarOperation.count({ where: input }), 0);
      // Fixture-only settlement removes the hold, but stale hashes still cannot send.
      await prisma.job.update({
        where: { id: job.id },
        data: {
          calendarEventId: "fixture-settled",
          serviceWindowStart: reservationStart,
          serviceWindowEnd: reservationEnd,
          technicianStatusUpdatedAt: new Date(
            job.technicianStatusUpdatedAt.getTime() + 1000,
          ),
        },
      });
      for (const event of await prisma.communicationEvent.findMany({
        where: input,
      })) {
        await prisma.communicationEvent.update({
          where: { id: event.id },
          data: { nextAttemptAt: new Date(0) },
        });
        assert.equal(
          await delivery.deliver(job.tenantId, event.id),
          "DEAD_LETTER",
        );
      }
    }
  }
  assert.equal(cases, 36);
  assert.equal(forbiddenCalls, 0);
  return [
    "36 legacy reference/window/template combinations refuse admission, capture and owner retry",
    "36 matching-hash intent and pre-send holds preserve retry budgets; no decrypt, consent or provider access",
    "nine transaction rollbacks preserve jobs/audits; tenant isolation and no-journal fixtures verified",
    "36 fixture-settled queued messages still reject stale/incompatible state before send",
  ];
}
