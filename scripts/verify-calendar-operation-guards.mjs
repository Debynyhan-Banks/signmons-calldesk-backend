// Parent-owned random local database only. No provider or Calendar network calls.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  CalendarOperationJournalService,
} = require("../dist/scheduling/calendar-operation-journal.service.js");
const {
  SchedulingService,
} = require("../dist/scheduling/scheduling.service.js");
const {
  AppointmentReschedulingService,
} = require("../dist/scheduling/appointment-rescheduling.service.js");
const {
  AppointmentCancellationService,
} = require("../dist/scheduling/appointment-cancellation.service.js");
const {
  DispatchBoardService,
} = require("../dist/jobs/dispatch-board.service.js");
const {
  SmsDeliveryService,
} = require("../dist/communications/sms-delivery.service.js");
const {
  transactionalMessageJobSelect,
  evaluateTransactionalMessageState,
} = require("../dist/communications/transactional-message-state.js");

export async function verifyCalendarOperationGuards({
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
  const journal = new CalendarOperationJournalService(prisma);
  const dispatch = new DispatchBoardService(prisma);
  const forbidden = () => {
    throw new Error("Unexpected external/notification action");
  };
  const config = {
    conversationDataEncryptionKey: "d".repeat(64),
    schedulingEnabled: true,
  };
  const scheduling = new SchedulingService(
    prisma,
    {},
    {},
    { recover: forbidden },
    {},
    {},
    {},
    config,
  );
  const delivery = new SmsDeliveryService(
    prisma,
    { evaluateOutbound: forbidden },
    { decrypt: forbidden },
    { send: forbidden },
    {},
  );
  const sign = (payload) => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${createHmac("sha256", config.conversationDataEncryptionKey).update(encoded).digest("base64url")}`;
  };
  const ids = [];
  try {
    for (const action of ["CREATE", "RESCHEDULE", "CANCEL"]) {
      const start = new Date(Date.now() + (ids.length + 100) * 86400000);
      const end = new Date(start.getTime() + 3600000);
      const job = await prisma.job.create({
        data: {
          ...jobData,
          intakeSessionId: randomUUID(),
          status: action === "CREATE" ? "CREATED" : "ACCEPTED",
          calendarEventId: action === "CREATE" ? null : randomUUID(),
          serviceWindowStart: action === "CREATE" ? null : start,
          serviceWindowEnd: action === "CREATE" ? null : end,
        },
      });
      ids.push(job.id);
      const operation = await journal.reserve({
        tenantId: job.tenantId,
        jobId: job.id,
        action,
        expectedUpdatedAt: job.updatedAt,
        calendarId: "fixture@example.invalid",
        timeZone: "UTC",
        start: new Date(end.getTime() + 3600000),
        end: new Date(end.getTime() + 7200000),
        label: "Provisional synthetic window",
      });
      const templateKey =
        action === "CANCEL" ? "APPOINTMENT_CANCELLED" : "APPOINTMENT_CONFIRMED";
      const intent = await prisma.smsEnqueueIntent.create({
        data: {
          tenantId: job.tenantId,
          jobId: job.id,
          templateKey,
          stateHash: "f".repeat(64),
          attemptCount: 4,
        },
      });
      const token = sign({
        version: 1,
        purpose: "appointment-management",
        tenantId: job.tenantId,
        jobId: job.id,
        expiresAt: Date.now() + 60000,
      });
      for (const status of [
        "PENDING",
        "UNCERTAIN",
        "APPLIED",
        "NEEDS_REVIEW",
      ]) {
        await prisma.calendarOperation.update({
          where: { id: operation.id },
          data: { status },
        });
        const selected = await prisma.job.findUniqueOrThrow({
          where: { id: job.id },
          select: transactionalMessageJobSelect,
        });
        for (const template of [
          "APPOINTMENT_CONFIRMED",
          "APPOINTMENT_RESCHEDULED",
          "APPOINTMENT_CANCELLED",
          "TECHNICIAN_ON_THE_WAY",
        ])
          assert.equal(
            evaluateTransactionalMessageState(template, selected),
            "CALENDAR_PENDING",
          );
        for (const customerAction of [
          "view",
          "confirm",
          "request_reschedule",
          "continue_payment",
          "availability",
          "reschedule",
          "cancel",
        ])
          await assert.rejects(
            scheduling.manageAppointment({
              managementToken: token,
              action: customerAction,
            }),
            /Calendar synchronization is unfinished/,
          );
        await assert.rejects(
          scheduling.confirmAppointment({
            tenantId: job.tenantId,
            jobId: job.id,
            sessionId: job.intakeSessionId,
            slotToken: sign({
              tenantId: job.tenantId,
              jobId: job.id,
              start: start.toISOString(),
              end: end.toISOString(),
              expiresAt: Date.now() + 60000,
            }),
          }),
          /Calendar synchronization is unfinished/,
        );
        const summary = (await dispatch.list(job.tenantId)).find(
          (row) => row.jobId === job.id,
        );
        assert.equal(summary.calendarSyncPending, true);
        assert.equal(summary.queue, "ESCALATED");
        assert.equal(
          (await dispatch.list(otherTenantId)).some(
            (row) => row.jobId === job.id,
          ),
          false,
        );
        const current = await prisma.job.findUniqueOrThrow({
          where: { id: job.id },
        });
        await assert.rejects(
          dispatch.assign({
            tenantId: job.tenantId,
            jobId: job.id,
            technicianId: jobData.assignedUserId,
            expectedUpdatedAt: current.updatedAt.toISOString(),
            actorId: "fixture",
            reason: "Approved override cannot bypass hold",
          }),
          /Calendar synchronization is unfinished/,
        );
        await assert.rejects(
          dispatch.cancelAssignment({
            tenantId: job.tenantId,
            jobId: job.id,
            expectedUpdatedAt: current.updatedAt.toISOString(),
            actorId: "fixture",
            reason: "Synthetic cancellation",
          }),
          /Calendar synchronization is unfinished/,
        );
        // Direct legacy claims must also fail even with the current job version.
        await assert.rejects(
          new AppointmentReschedulingService(prisma, {}, {}).claim(
            current,
            start,
            end,
            "fixture",
          ),
          /changed before/,
        );
        await assert.rejects(
          new AppointmentCancellationService(prisma, {}, {}).claim(
            current,
            "fixture",
          ),
          /changed before/,
        );
        await assert.rejects(
          messaging.queue({
            tenantId: job.tenantId,
            jobId: job.id,
            templateKey,
            idempotencyKey: randomUUID(),
          }),
          /current job status/,
        );
        await assert.rejects(
          intents.recordConfirmation(prisma, {
            tenantId: job.tenantId,
            jobId: job.id,
          }),
          /compatible job state/,
        );
        await prisma.smsEnqueueIntent.update({
          where: { id: intent.id },
          data: { nextAttemptAt: new Date(0) },
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
        assert.equal(held.lastErrorCode, "calendar_sync_pending");
        assert.ok(held.nextAttemptAt > new Date());
        const event = await prisma.communicationEvent.create({
          data: {
            tenantId: job.tenantId,
            jobId: job.id,
            jobTenantId: job.tenantId,
            channel: "SMS",
            direction: "OUTBOUND",
            provider: "TWILIO",
            status: "QUEUED",
            attemptCount: 2,
            content: {
              create: {
                tenantId: job.tenantId,
                payload: {
                  kind: "transactional_sms",
                  templateKey,
                  lifecycleStateHash: "f".repeat(64),
                },
                encryptedRaw: "must-not-decrypt",
              },
            },
          },
        });
        assert.equal(await delivery.deliver(job.tenantId, event.id), "QUEUED");
        const heldEvent = await prisma.communicationEvent.findUniqueOrThrow({
          where: { id: event.id },
        });
        assert.equal(heldEvent.attemptCount, 2);
        assert.equal(heldEvent.lastErrorCode, "calendar_sync_pending");
        assert.ok(heldEvent.nextAttemptAt > new Date());
        await assert.rejects(
          delivery.deliver(job.tenantId, event.id),
          /not claimable/,
        );
        assert.deepEqual(
          await prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
          current,
        );
      }
      await prisma.calendarOperation.update({
        where: { id: operation.id },
        data: { status: "ABORTED", finishedAt: new Date() },
      });
      const settled = await prisma.job.findUniqueOrThrow({
        where: { id: job.id },
        select: transactionalMessageJobSelect,
      });
      assert.equal(
        evaluateTransactionalMessageState(templateKey, settled),
        action === "CREATE" ? "CALENDAR_PENDING" : "AVAILABLE",
      );
      // Terminal history removes only the journal hold, not an unconfirmed CREATE.
      // Other changed lifecycles must still stop at the ordinary state/hash gate.
      await prisma.smsEnqueueIntent.update({
        where: { id: intent.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await intents.processOne({ tenantId: job.tenantId, intentId: intent.id });
      assert.equal(
        (
          await prisma.smsEnqueueIntent.findUniqueOrThrow({
            where: { id: intent.id },
          })
        ).status,
        action === "CREATE" ? "PENDING" : "STALE",
      );
      if (action === "CANCEL") {
        // With no unfinished journal, the existing compatible-state policy works again.
        const fresh = await intents.recordCancellation(prisma, {
          tenantId: job.tenantId,
          jobId: job.id,
        });
        await intents.processOne({
          tenantId: job.tenantId,
          intentId: fresh.id,
        });
        assert.equal(
          (
            await prisma.smsEnqueueIntent.findUniqueOrThrow({
              where: { id: fresh.id },
            })
          ).status,
          "QUEUED",
        );
      }
    }
    return [
      "12 real journal action/status combinations fail closed across customer/dispatch/admission/delivery",
      "pending cancellations remain visible and tenant scoped",
      "legacy mutation claims reject current-version pending journals",
      "enqueue and delivery holds preserve retry budgets and enforce delay",
      "terminal journal removes journal hold only; unconfirmed CREATE remains held and other stale states reject",
    ];
  } finally {
    await prisma.calendarOperation.deleteMany({
      where: { jobId: { in: ids }, tenantId: jobData.tenantId },
    });
  }
}
