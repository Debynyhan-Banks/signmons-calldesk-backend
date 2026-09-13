// Parent-owned disposable database only; no Stripe/Calendar/notification adapters.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  SchedulingService,
} = require("../dist/scheduling/scheduling.service.js");
const {
  AppointmentConfirmationService,
} = require("../dist/scheduling/appointment-confirmation.service.js");

export async function verifyInitialBookingPayment({
  prisma,
  intents,
  jobData,
}) {
  const [local] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(local.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(local.address, null);
  const category = await prisma.serviceCategory.create({
    data: { tenantId: jobData.tenantId, name: "COOLING" },
  });
  const config = {
    schedulingEnabled: true,
    schedulingTimeZone: "UTC",
    conversationDataEncryptionKey: "a".repeat(64),
  };
  let sequence = 0,
    availability = 0,
    inserts = 0;
  const messageCount = await prisma.communicationEvent.count();
  const finalizer = new AppointmentConfirmationService(
    prisma,
    {
      recordConfirmation: intents.recordConfirmation.bind(intents),
      processOne: async () => {}, // No enqueue/send from this local proof.
    },
    { error: () => {} },
  );
  const makeService = () => {
    const service = new SchedulingService(
      prisma,
      { enqueueAppointmentConfirmed: () => {} },
      { error: () => {} },
      {},
      {},
      finalizer,
      {},
      config,
    );
    service.fetchBusy = async () => {
      availability++;
      return [];
    };
    service.insertCalendarEvent = async () => {
      inserts++;
      return `synthetic-paid-${inserts}`;
    };
    return service;
  };
  const make = async (policy, status) => {
    sequence++;
    const job = await prisma.job.create({
      data: {
        ...jobData,
        status: "CREATED",
        intakeSessionId: randomUUID(),
        serviceCategoryId: category.id,
        assignedUserId: null,
        assignedUserTenantId: null,
        technicianStatus: null,
        calendarEventId: null,
        serviceWindowStart: null,
        serviceWindowEnd: null,
        policySnapshot: {
          propertyType: "RESIDENTIAL",
          serviceIntent: "DIAGNOSTIC",
          ...policy,
        },
      },
    });
    const payment = status
      ? await prisma.payment.create({
          data: {
            tenantId: job.tenantId,
            jobId: job.id,
            jobTenantId: job.tenantId,
            status,
            amountTotalCents: 100,
            applicationFeeAmountCents: 0,
            currency: "usd",
          },
        })
      : null;
    const start = new Date(Date.UTC(2038, 0, sequence, 14));
    const end = new Date(start.getTime() + 3600000);
    const raw = Buffer.from(
      JSON.stringify({
        tenantId: job.tenantId,
        jobId: job.id,
        start: start.toISOString(),
        end: end.toISOString(),
        expiresAt: Date.now() + 60_000,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", config.conversationDataEncryptionKey)
      .update(raw)
      .digest("base64url");
    return {
      job,
      payment,
      input: {
        tenantId: job.tenantId,
        jobId: job.id,
        sessionId: job.intakeSessionId,
        slotToken: `${raw}.${signature}`,
      },
    };
  };
  const assertUntouched = async (fixture) => {
    assert.deepEqual(
      await prisma.job.findUniqueOrThrow({ where: { id: fixture.job.id } }),
      fixture.job,
    );
    for (const model of ["smsEnqueueIntent", "calendarOperation"]) {
      assert.equal(
        await prisma[model].count({ where: { jobId: fixture.job.id } }),
        0,
      );
    }
    assert.equal(
      await prisma.auditLog.count({ where: { entityId: fixture.job.id } }),
      0,
    );
  };
  for (const flag of ["depositRequired", "serviceFeeRequired"]) {
    for (const status of [null, "PENDING", "FAILED", "REFUNDED", "CANCELED"]) {
      const fixture = await make({ [flag]: true }, status);
      await assert.rejects(
        makeService().confirmAppointment(fixture.input),
        /Required payment/,
      );
      await assertUntouched(fixture);
    }
  }
  assert.equal(availability, 0);
  assert.equal(inserts, 0);

  for (const [policy, status] of [
    [{ depositRequired: true }, "SUCCEEDED"],
    [{}, "FAILED"],
    [
      {
        serviceFeeRequired: true,
        paymentGateMode: "manual_override",
        paymentGateException: {
          active: true,
          approvedAt: "2026-09-09T12:00:00Z",
          reason: "Synthetic approval",
        },
      },
      "FAILED",
    ],
  ]) {
    const fixture = await make(policy, status);
    const service = makeService();
    assert.equal(
      (await service.confirmAppointment(fixture.input)).status,
      "appointment_confirmed",
    );
    const beforeReplay = inserts;
    assert.equal(
      (await service.confirmAppointment(fixture.input)).status,
      "appointment_confirmed",
    );
    assert.equal(inserts, beforeReplay);
    assert.equal(
      await prisma.smsEnqueueIntent.count({ where: { jobId: fixture.job.id } }),
      1,
    );
    assert.equal(
      await prisma.auditLog.count({ where: { entityId: fixture.job.id } }),
      1,
    );
  }
  assert.equal(inserts, 3);
  for (const mutation of ["refund", "version", "replacement"]) {
    const fixture = await make({ depositRequired: true }, "SUCCEEDED");
    const service = makeService();
    let winningPayment;
    service.fetchBusy = async () => {
      if (mutation === "replacement") {
        await prisma.payment.delete({ where: { id: fixture.payment.id } });
        await prisma.payment.create({
          data: {
            tenantId: fixture.job.tenantId,
            jobId: fixture.job.id,
            jobTenantId: fixture.job.tenantId,
            status: "SUCCEEDED",
            amountTotalCents: 100,
            applicationFeeAmountCents: 0,
            currency: "usd",
          },
        });
      } else {
        await prisma.payment.update({
          where: { id: fixture.payment.id },
          data: {
            status: mutation === "refund" ? "REFUNDED" : "SUCCEEDED",
            updatedAt: new Date(fixture.payment.updatedAt.getTime() + 1000),
          },
        });
      }
      winningPayment = await prisma.payment.findFirstOrThrow({
        where: { jobId: fixture.job.id, tenantId: fixture.job.tenantId },
      });
      return [];
    };
    await assert.rejects(
      service.confirmAppointment(fixture.input),
      /appointment selection/,
    );
    await assertUntouched(fixture);
    assert.deepEqual(
      await prisma.payment.findUniqueOrThrow({
        where: { id: winningPayment.id },
      }),
      winningPayment,
    );
    assert.equal(inserts, 3);
  }
  const denied = await make({ depositRequired: true }, null);
  await assert.rejects(
    makeService().confirmAppointment({
      ...denied.input,
      sessionId: randomUUID(),
    }),
    /not found/,
  );
  await assert.rejects(
    makeService().confirmAppointment({
      ...denied.input,
      tenantId: randomUUID(),
    }),
    /invalid/,
  );
  await assertUntouched(denied);
  assert.equal(await prisma.communicationEvent.count(), messageCount);
  return [
    "ten required-payment refusals before availability/insert with unchanged job and no audit/intent/journal",
    "successful payment, no requirement and approved exception each finalize once and replay without insertion",
    "refund, successful-payment version change and replacement during availability reject reservation CAS without overwriting payment",
    "tenant/session authority precedes payment disclosure; fixture-owned payment changes only, no provider call or real payment/message action",
  ];
}
