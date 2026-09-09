// Parent-owned random local database. Real admission/journal/executor/finalizer;
// Calendar availability/write/read are synthetic; no legacy insert or message.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  SchedulingService,
} = require("../dist/scheduling/scheduling.service.js");
const {
  JournaledAppointmentBookingService,
} = require("../dist/scheduling/journaled-appointment-booking.service.js");
const {
  CalendarOperationJournalService,
} = require("../dist/scheduling/calendar-operation-journal.service.js");
const {
  CalendarCreateExecutionService,
} = require("../dist/scheduling/calendar-create-execution.service.js");
const {
  CalendarCreateReconciliationService,
} = require("../dist/scheduling/calendar-create-reconciliation.service.js");

export async function verifyJournaledAppointmentBooking({
  prisma,
  intents,
  jobData,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const category = await prisma.serviceCategory.create({
    data: { tenantId: jobData.tenantId, name: "COOLING" },
  });
  const config = {
    schedulingEnabled: true,
    schedulingTimeZone: "UTC",
    googleCalendarId: "fixture@example.invalid",
    conversationDataEncryptionKey: "a".repeat(64),
  };
  const ids = [],
    seen = new Map();
  let inserts = 0,
    availability = 0;
  const messages = await prisma.communicationEvent.count();
  const forbidden = () => {
    throw new Error("Legacy/provider/message path forbidden");
  };
  const journal = new CalendarOperationJournalService(prisma);
  const makeServices = ({
    mode = "matched",
    busy = false,
    afterAvailability,
    reservation = journal,
    enabled = true,
    beforeReceipt,
  } = {}) => {
    const admission = new SchedulingService(
      prisma,
      { enqueueAppointmentConfirmed: forbidden },
      { error: forbidden },
      {},
      {},
      { finalize: forbidden },
      {},
      { ...config, schedulingEnabled: enabled },
    );
    admission.insertCalendarEvent = forbidden;
    const readReceipt =
      admission.readInitialConfirmationReceipt.bind(admission);
    admission.readInitialConfirmationReceipt = async (input, proof) => {
      if (beforeReceipt) await beforeReceipt(input, proof);
      return readReceipt(input, proof);
    };
    admission.fetchBusy = async (start, end) => {
      availability++;
      if (afterAvailability) await afterAvailability();
      return busy
        ? [{ start: start.toISOString(), end: end.toISOString() }]
        : [];
    };
    const recovery = new CalendarCreateReconciliationService(
      prisma,
      {
        read: async (_calendar, id) =>
          mode === "unavailable"
            ? { outcome: "unavailable" }
            : mode === "absent"
              ? { outcome: "unverified" }
              : { outcome: "found", event: seen.get(id) },
      },
      intents,
    );
    const executor = new CalendarCreateExecutionService(
      prisma,
      {
        create: async (request) => {
          inserts++;
          const operation = await prisma.calendarOperation.findUniqueOrThrow({
            where: { id: request.operationId },
          });
          assert.equal(operation.status, "UNCERTAIN");
          assert.equal(operation.calendarId, config.googleCalendarId);
          assert.equal(operation.calendarEventId, request.eventId);
          assert.equal(
            await prisma.smsEnqueueIntent.count({
              where: { jobId: request.jobId },
            }),
            0,
          );
          seen.set(request.eventId, {
            id: request.eventId,
            etag: '"synthetic"',
            status: "confirmed",
            blockingSingleEvent: true,
            start: request.start.toISOString(),
            end: request.end.toISOString(),
            tenantId: request.tenantId,
            jobId: request.jobId,
            operationId: request.operationId,
          });
          if (mode === "throw-matched")
            throw new Error("Synthetic unknown acknowledgment");
        },
      },
      recovery,
    );
    return new JournaledAppointmentBookingService(
      admission,
      reservation,
      executor,
      config,
    );
  };
  const make = async (policy = {}, paymentStatus) => {
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
    ids.push(job.id);
    const payment = paymentStatus
      ? await prisma.payment.create({
          data: {
            tenantId: job.tenantId,
            jobId: job.id,
            jobTenantId: job.tenantId,
            status: paymentStatus,
            amountTotalCents: 100,
            applicationFeeAmountCents: 0,
            currency: "usd",
          },
        })
      : null;
    const start = new Date(Date.UTC(2039, 0, ids.length, 14)),
      end = new Date(start.getTime() + 3600000);
    const raw = Buffer.from(
      JSON.stringify({
        tenantId: job.tenantId,
        jobId: job.id,
        start: start.toISOString(),
        end: end.toISOString(),
        expiresAt: Date.now() + 60000,
      }),
    ).toString("base64url");
    return {
      job,
      payment,
      input: {
        tenantId: job.tenantId,
        jobId: job.id,
        sessionId: job.intakeSessionId,
        slotToken: `${raw}.${createHmac("sha256", config.conversationDataEncryptionKey).update(raw).digest("base64url")}`,
      },
    };
  };
  const operations = (f) =>
    prisma.calendarOperation.findMany({ where: { jobId: f.job.id } });
  const readJob = (f) =>
    prisma.job.findUniqueOrThrow({ where: { id: f.job.id } });
  const noSuccess = async (f) => {
    assert.equal(
      await prisma.smsEnqueueIntent.count({ where: { jobId: f.job.id } }),
      0,
    );
    assert.equal(
      await prisma.auditLog.count({ where: { entityId: f.job.id } }),
      0,
    );
  };
  const untouched = async (f) => {
    assert.deepEqual(await readJob(f), f.job);
    assert.equal((await operations(f)).length, 0);
    await noSuccess(f);
  };
  try {
    const denied = await make({ depositRequired: true });
    for (const [overrides, opts] of [
      [{ slotToken: "bad" }, {}],
      [{ tenantId: randomUUID() }, {}],
      [{ sessionId: randomUUID() }, {}],
      [{}, { enabled: false }],
      [{}, {}],
    ]) {
      await assert.rejects(
        makeServices(opts).book({ ...denied.input, ...overrides }),
      );
      await untouched(denied);
    }
    assert.equal(availability, 0);
    assert.equal(inserts, 0);
    const busy = await make();
    await assert.rejects(
      makeServices({ busy: true }).book(busy.input),
      /just taken/,
    );
    await untouched(busy);
    for (const data of [{ deletedAt: new Date() }, { status: "CANCELLED" }]) {
      const f = await make();
      f.job = await prisma.job.update({ where: { id: f.job.id }, data });
      await assert.rejects(makeServices().book(f.input), /no longer available/);
      await untouched(f);
    }
    // A payment valid at preflight may be revoked before durable admission.
    const paidRace = await make({ depositRequired: true }, "SUCCEEDED");
    await assert.rejects(
      makeServices({
        afterAvailability: () =>
          prisma.payment.update({
            where: { id: paidRace.payment.id },
            data: { status: "REFUNDED" },
          }),
      }).book(paidRace.input),
      /Appointment changed/,
    );
    await untouched(paidRace);
    assert.equal(
      (await prisma.payment.findUnique({ where: { id: paidRace.payment.id } }))
        .status,
      "REFUNDED",
    );
    assert.equal(inserts, 0);

    for (const mode of ["matched", "throw-matched"]) {
      const f = await make({ depositRequired: true }, "SUCCEEDED");
      const service = makeServices({ mode });
      const before = inserts;
      const receipt = await service.book(f.input);
      const replay = await service.book(f.input);
      assert.equal(receipt.status, "appointment_confirmed");
      assert.equal(replay.status, "appointment_confirmed");
      assert.deepEqual(replay.job, receipt.job);
      assert.deepEqual(replay.appointment, receipt.appointment);
      const token = JSON.parse(
        Buffer.from(
          receipt.managementToken.split(".")[0],
          "base64url",
        ).toString(),
      );
      assert.equal(token.tenantId, f.job.tenantId);
      assert.equal(token.jobId, f.job.id);
      assert.equal(token.purpose, "appointment-management");
      for (const field of [
        "calendarOperations",
        "policySnapshot",
        "payment",
        "operationId",
        "calendarId",
      ])
        assert.equal(Object.hasOwn(receipt.job, field), false);
      assert.equal(inserts, before + 1);
      assert.equal((await operations(f)).length, 1);
      assert.equal((await operations(f))[0].status, "FINALIZED");
      assert.equal(
        await prisma.smsEnqueueIntent.count({ where: { jobId: f.job.id } }),
        1,
      );
      assert.equal(
        await prisma.auditLog.count({
          where: {
            entityId: f.job.id,
            action: "appointment.initial_confirmed",
          },
        }),
        1,
      );
    }
    // Requests cannot take over earlier unfinished reservations, even on replay.
    for (const mode of ["unavailable", "absent"]) {
      const f = await make(),
        before = inserts;
      const service = makeServices({ mode });
      await assert.rejects(service.book(f.input), /confirmation by the office/);
      const held = await readJob(f),
        saved = await operations(f);
      await assert.rejects(
        service.book(f.input),
        /Calendar synchronization is unfinished/,
      );
      assert.deepEqual(await readJob(f), held);
      assert.deepEqual(await operations(f), saved);
      assert.equal(inserts, before + 1);
      await noSuccess(f);
    }
    const ack = await make(),
      beforeAck = inserts;
    const unknown = makeServices({
      reservation: {
        reserve: async (input) => {
          await journal.reserve(input);
          throw new Error("Synthetic lost reservation acknowledgment");
        },
      },
    });
    await assert.rejects(unknown.book(ack.input), /confirmation by the office/);
    const held = await readJob(ack),
      saved = await operations(ack);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].status, "PENDING");
    await assert.rejects(
      makeServices().book(ack.input),
      /Calendar synchronization is unfinished/,
    );
    assert.deepEqual(await readJob(ack), held);
    assert.deepEqual(await operations(ack), saved);
    assert.equal(inserts, beforeAck);
    await noSuccess(ack);

    const race = await make(),
      beforeRace = inserts;
    const results = await Promise.allSettled([
      makeServices().book(race.input),
      makeServices().book(race.input),
    ]);
    assert.ok(
      results.some(
        (r) =>
          r.status === "fulfilled" &&
          r.value.status === "appointment_confirmed",
      ),
    );
    assert.equal(inserts, beforeRace + 1);
    assert.equal((await operations(race)).length, 1);
    assert.equal(
      await prisma.smsEnqueueIntent.count({ where: { jobId: race.job.id } }),
      1,
    );
    assert.equal(
      await prisma.auditLog.count({
        where: {
          entityId: race.job.id,
          action: "appointment.initial_confirmed",
        },
      }),
      1,
    );
    // A finalized executor result cannot authorize a stale customer receipt.
    // These are committed synthetic changes between finalization and receipt read.
    for (const change of [
      "event",
      "window",
      "cancelled",
      "deleted",
      "session",
      "journal-hold",
      "journal-window",
    ]) {
      const f = await make(),
        before = inserts;
      let winner, saved;
      const service = makeServices({
        beforeReceipt: async (input, proof) => {
          const current = await readJob(f);
          const data =
            change === "event"
              ? { calendarEventId: "replacement-event" }
              : change === "window"
                ? {
                    serviceWindowEnd: new Date(
                      current.serviceWindowEnd.getTime() + 3600000,
                    ),
                  }
                : change === "cancelled"
                  ? { status: "CANCELLED" }
                  : change === "deleted"
                    ? { deletedAt: new Date() }
                    : change === "session"
                      ? { intakeSessionId: randomUUID() }
                      : null;
          if (data)
            await prisma.job.update({ where: { id: input.jobId }, data });
          if (change === "journal-hold")
            await prisma.calendarOperation.update({
              where: { id: proof.operationId },
              data: { status: "NEEDS_REVIEW", finishedAt: null },
            });
          if (change === "journal-window")
            await prisma.calendarOperation.update({
              where: { id: proof.operationId },
              data: {
                desiredWindowEnd: new Date(
                  current.serviceWindowEnd.getTime() + 3600000,
                ),
              },
            });
          winner = await readJob(f);
          saved = await operations(f);
        },
      });
      await assert.rejects(service.book(f.input), /confirmation by the office/);
      assert.deepEqual(await readJob(f), winner);
      assert.deepEqual(await operations(f), saved);
      assert.equal(inserts, before + 1);
      assert.equal(
        await prisma.smsEnqueueIntent.count({ where: { jobId: f.job.id } }),
        1,
      );
      assert.equal(
        await prisma.auditLog.count({
          where: {
            entityId: f.job.id,
            action: "appointment.initial_confirmed",
          },
        }),
        1,
      );
    }
    const replayRace = await make();
    await makeServices().book(replayRace.input);
    const replayBefore = inserts,
      availabilityBefore = availability;
    let replayWinner;
    await assert.rejects(
      makeServices({
        beforeReceipt: async () => {
          const current = await readJob(replayRace);
          replayWinner = await prisma.job.update({
            where: { id: current.id },
            data: { updatedAt: new Date(current.updatedAt.getTime() + 1000) },
          });
        },
      }).book(replayRace.input),
      /confirmation by the office/,
    );
    assert.deepEqual(await readJob(replayRace), replayWinner);
    assert.equal(inserts, replayBefore);
    assert.equal(availability, availabilityBefore);

    const receiptReader = new SchedulingService(
      prisma,
      {},
      {},
      {},
      {},
      {},
      {},
      config,
    );
    const [replayJournal] = await operations(replayRace);
    const proof = {
      operationId: replayJournal.id,
      calendarEventId: replayJournal.calendarEventId,
    };
    const receiptJob = await readJob(replayRace),
      receiptOperations = await operations(replayRace);
    for (const request of [
      { ...replayRace.input, sessionId: randomUUID() },
      { ...replayRace.input, tenantId: randomUUID() },
      { ...replayRace.input, slotToken: "invalid" },
    ])
      await assert.rejects(
        receiptReader.readInitialConfirmationReceipt(request, proof),
      );
    await assert.rejects(
      receiptReader.readInitialConfirmationReceipt(replayRace.input, {
        ...proof,
        operationId: randomUUID(),
      }),
    );
    assert.deepEqual(await readJob(replayRace), receiptJob);
    assert.deepEqual(await operations(replayRace), receiptOperations);
    assert.equal(await prisma.communicationEvent.count(), messages);
    return [
      "fresh scoped receipts return existing confirmation shape/private management token only for settled matching bookings",
      "seven committed post-finalization job/journal changes refuse stale receipts without undoing successful intent/audit",
      "settled replay version race refuses receipt without new availability/insert; independent receipt authority/proof refusals are read-only",
      "composed signed booking refuses invalid tenant/session/token, disabled, unpaid, busy, deleted and closed before journaling",
      "payment revoked during availability fails canonical journal admission without insertion",
      "real admission/journal/executor/readback produce one intent/audit with finalized replay; thrown insert acknowledgment still needs readback",
      "unknown/absent provider evidence retains pending/review hold and requests cannot resume it",
      "lost reservation acknowledgment leaves PENDING without execution, reinsertion or request takeover",
      "concurrent composed bookings create one journal/provider attempt/finalization intent/audit; zero real provider/message calls",
    ];
  } finally {
    await prisma.calendarOperation.deleteMany({
      where: { tenantId: jobData.tenantId, jobId: { in: ids } },
    });
  }
}
