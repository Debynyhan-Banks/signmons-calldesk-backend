import { createHmac } from "crypto";
import { GoogleAuth } from "google-auth-library";
import type { AppConfig } from "../config/app.config";
import type { JobNotificationService } from "../jobs/job-notification.service";
import type { JobRecord } from "../jobs/interfaces/job-repository.interface";
import type { LoggingService } from "../logging/logging.service";
import type { PaymentRequestsService } from "../payments/payment-requests.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { AppointmentReschedulingService } from "./appointment-rescheduling.service";
import { SchedulingService } from "./scheduling.service";
import type { AppointmentConfirmationService } from "./appointment-confirmation.service";
import type { AppointmentCancellationService } from "./appointment-cancellation.service";

describe("SchedulingService", () => {
  const config = {
    schedulingEnabled: true,
    googleCalendarId: "dispatch@example.com",
    schedulingTimeZone: "America/New_York",
    schedulingLookaheadDays: 14,
    schedulingMinNoticeMinutes: 120,
    conversationDataEncryptionKey: "a".repeat(64),
  } as AppConfig;
  const baseJob: JobRecord = {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    customerName: "Test Customer",
    phone: "+12165550100",
    address: "100 Test Street, Cleveland, OH",
    issueCategory: "COOLING",
    urgency: "STANDARD",
    description: "AC is blowing warm air",
    propertyType: "RESIDENTIAL",
    serviceIntent: "DIAGNOSTIC",
    status: "CREATED",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = {
    $transaction: jest.fn(),
    job: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    auditLog: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
    },
  };
  const notifications = {
    enqueueAppointmentConfirmed: jest.fn(),
    enqueueAppointmentRescheduled: jest.fn(),
    enqueueAppointmentCancelled: jest.fn(),
  };
  const logger = {
    error: jest.fn(),
  };
  const paymentRequests = {
    recover: jest.fn(),
  };
  const rescheduling = {
    claim: jest.fn(),
    finalize: jest.fn(),
    restore: jest.fn(),
    assertFinalized: jest.fn(),
    logDeferred: jest.fn(),
  };
  const confirmation = { finalize: jest.fn() };
  const cancellation = {
    claim: jest.fn(),
    finalize: jest.fn(),
    restore: jest.fn(),
    assertFinalized: jest.fn(),
    logDeferred: jest.fn(),
  };

  let service: SchedulingService;

  beforeEach(() => {
    jest.restoreAllMocks();
    prisma.$transaction.mockImplementation(
      (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
    );
    prisma.job.findMany.mockResolvedValue([]);
    prisma.job.findFirst.mockReset();
    prisma.job.updateMany.mockReset().mockResolvedValue({ count: 1 });
    prisma.job.update.mockReset();
    prisma.auditLog.findMany.mockReset().mockResolvedValue([]);
    prisma.auditLog.create.mockReset().mockResolvedValue({ id: "audit-1" });
    notifications.enqueueAppointmentRescheduled.mockReset();
    notifications.enqueueAppointmentConfirmed.mockReset();
    logger.error.mockReset();
    confirmation.finalize.mockReset();
    cancellation.claim.mockReset().mockResolvedValue({
      id: baseJob.id,
      tenantId: baseJob.tenantId,
      updatedAt: new Date(),
    });
    cancellation.finalize.mockReset().mockResolvedValue(undefined);
    cancellation.restore.mockReset().mockResolvedValue({ count: 1 });
    cancellation.assertFinalized.mockReset().mockResolvedValue(undefined);
    cancellation.logDeferred.mockReset();
    notifications.enqueueAppointmentCancelled.mockReset();
    rescheduling.finalize.mockReset().mockResolvedValue(undefined);
    rescheduling.claim.mockReset().mockResolvedValue({
      id: baseJob.id,
      tenantId: baseJob.tenantId,
      updatedAt: new Date(),
    });
    rescheduling.restore.mockReset().mockResolvedValue({ count: 1 });
    rescheduling.assertFinalized.mockReset().mockResolvedValue(undefined);
    rescheduling.logDeferred.mockReset();
    paymentRequests.recover.mockReset().mockResolvedValue({
      status: "payment_checkout",
      checkoutUrl: "https://checkout.stripe.com/c/pay/test",
      checkoutExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    service = new SchedulingService(
      prisma as unknown as PrismaService,
      notifications as unknown as JobNotificationService,
      logger as unknown as LoggingService,
      paymentRequests as unknown as PaymentRequestsService,
      rescheduling as unknown as AppointmentReschedulingService,
      confirmation as unknown as AppointmentConfirmationService,
      cancellation as unknown as AppointmentCancellationService,
      config,
    );
  });

  it("allows complete standard residential heating or cooling diagnostic and repair visits", () => {
    expect(service.isInstantBookingEligible(baseJob)).toBe(true);
    expect(
      service.isInstantBookingEligible({
        ...baseJob,
        serviceIntent: "REPAIR",
      }),
    ).toBe(true);
    expect(
      service.isInstantBookingEligible({
        ...baseJob,
        propertyType: "COMMERCIAL",
      }),
    ).toBe(false);
    expect(
      service.isInstantBookingEligible({
        ...baseJob,
        serviceIntent: "INSTALLATION",
      }),
    ).toBe(false);
    expect(
      service.isInstantBookingEligible({ ...baseJob, urgency: "EMERGENCY" }),
    ).toBe(false);
    expect(
      service.isInstantBookingEligible({
        ...baseJob,
        address: "Unknown address",
      }),
    ).toBe(false);
  });

  it("returns signed weekday windows after excluding calendar conflicts", async () => {
    jest.spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue({
      getRequestHeaders: jest.fn().mockResolvedValue(
        new Headers({
          authorization: "Bearer test",
        }),
      ),
    } as never);
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        calendars: { "dispatch@example.com": { busy: [] } },
      }),
    } as never);

    const slots = await service.getAvailableSlots(baseJob);

    expect(slots).toHaveLength(8);
    expect(slots[0]).toEqual(
      expect.objectContaining({
        label: expect.stringMatching(/AM|PM/),
        token: expect.stringContaining("."),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.googleapis.com/calendar/v3/freeBusy",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("queues one canonical confirmation after the calendar appointment commits", async () => {
    const start = new Date("2026-09-10T15:00:00.000Z");
    const end = new Date("2026-09-10T18:00:00.000Z");
    const pending = appointmentJob({
      status: "CREATED",
      calendarEventId: null,
      serviceWindowStart: null,
      serviceWindowEnd: null,
    });
    const confirmed = appointmentJob({
      serviceWindowStart: start,
      serviceWindowEnd: end,
      calendarEventId: "event-confirmed",
    });
    prisma.job.findFirst.mockResolvedValue(pending);
    prisma.job.updateMany.mockResolvedValue({ count: 1 });
    confirmation.finalize.mockResolvedValue(confirmed);
    jest.spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue({
      getRequestHeaders: jest
        .fn()
        .mockResolvedValue(new Headers({ authorization: "Bearer test" })),
    } as never);
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            calendars: { "dispatch@example.com": { busy: [] } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "event-confirmed" }), {
          status: 200,
        }),
      );

    await expect(
      service.confirmAppointment({
        tenantId: baseJob.tenantId,
        sessionId: "session-1",
        jobId: baseJob.id,
        slotToken: signedSlot(start, end),
      }),
    ).resolves.toEqual(
      expect.objectContaining({ status: "appointment_confirmed" }),
    );
    expect(confirmation.finalize).toHaveBeenCalledWith({
      tenantId: baseJob.tenantId,
      jobId: baseJob.id,
      calendarEventId: "event-confirmed",
      start,
      end,
    });
    expect(rescheduling.finalize).not.toHaveBeenCalled();
  });

  it("does not claim a reservation without a calendar reference is confirmed", async () => {
    const job = appointmentJob({ calendarEventId: null });
    prisma.job.findFirst.mockResolvedValue(job);
    await expect(
      service.confirmAppointment({
        tenantId: baseJob.tenantId,
        sessionId: "session-1",
        jobId: baseJob.id,
        slotToken: signedSlot(job.serviceWindowStart, job.serviceWindowEnd),
      }),
    ).rejects.toThrow("awaiting finalization");
    expect(confirmation.finalize).not.toHaveBeenCalled();
    expect(prisma.job.updateMany).not.toHaveBeenCalled();
  });
  it.each([
    { status: "CANCELLED" },
    { status: "COMPLETED" },
    { deletedAt: new Date() },
  ])("does not reopen a closed/deleted booking: %j", async (overrides) => {
    const job = appointmentJob(overrides);
    prisma.job.findFirst.mockResolvedValue(job);
    await expect(
      service.confirmAppointment({
        tenantId: baseJob.tenantId,
        sessionId: "session-1",
        jobId: baseJob.id,
        slotToken: signedSlot(job.serviceWindowStart, job.serviceWindowEnd),
      }),
    ).rejects.toThrow("no longer available");
    expect(prisma.job.updateMany).not.toHaveBeenCalled();
    expect(confirmation.finalize).not.toHaveBeenCalled();
  });

  it("replays a finalized booking without recapturing or requeueing", async () => {
    const job = appointmentJob();
    prisma.job.findFirst.mockResolvedValue(job);
    await expect(
      service.confirmAppointment({
        tenantId: baseJob.tenantId,
        sessionId: "session-1",
        jobId: baseJob.id,
        slotToken: signedSlot(job.serviceWindowStart, job.serviceWindowEnd),
      }),
    ).resolves.toEqual(
      expect.objectContaining({ status: "appointment_confirmed" }),
    );
    expect(confirmation.finalize).not.toHaveBeenCalled();
    expect(rescheduling.finalize).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "retains an acknowledged calendar reservation when finalization fails (logger fails: %s)",
    async (loggerFails) => {
      const start = new Date("2026-09-10T15:00:00Z");
      const end = new Date("2026-09-10T18:00:00Z");
      prisma.job.findFirst.mockResolvedValue(
        appointmentJob({
          status: "CREATED",
          calendarEventId: null,
          serviceWindowStart: null,
          serviceWindowEnd: null,
        }),
      );
      prisma.job.updateMany.mockResolvedValue({ count: 1 });
      confirmation.finalize.mockRejectedValue(
        new Error("PRIVATE_DATABASE_ERROR"),
      );
      if (loggerFails)
        logger.error.mockImplementation(() => {
          throw new Error("logging failed");
        });
      mockCalendarInsert();
      await expect(
        service.confirmAppointment({
          tenantId: baseJob.tenantId,
          sessionId: "session-1",
          jobId: baseJob.id,
          slotToken: signedSlot(start, end),
        }),
      ).rejects.toThrow("needs confirmation by the office");
      expect(prisma.job.updateMany).toHaveBeenCalledTimes(1);
      expect(notifications.enqueueAppointmentConfirmed).not.toHaveBeenCalled();
      expect(rescheduling.finalize).not.toHaveBeenCalled();
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
        "PRIVATE_DATABASE_ERROR",
      );
      expect(global.fetch).toHaveBeenCalledTimes(2);
    },
  );

  describe("unknown initial Calendar insert outcomes", () => {
    const cases = [
      "timeout",
      "connection-loss",
      "provider-500",
      "provider-400",
      "malformed-json",
      "missing-id",
      "credential-failure",
    ];
    it.each(
      cases.flatMap((outcome) =>
        [false, true].map((loggerFails) => ({ outcome, loggerFails })),
      ),
    )(
      "holds the reservation for $outcome (logger fails: $loggerFails)",
      async ({ outcome, loggerFails }) => {
        const start = new Date("2099-09-10T15:00:00Z");
        const end = new Date("2099-09-10T18:00:00Z");
        prisma.job.findFirst.mockResolvedValue(
          appointmentJob({
            status: "CREATED",
            calendarEventId: null,
            serviceWindowStart: null,
            serviceWindowEnd: null,
          }),
        );
        const client = jest
          .spyOn(GoogleAuth.prototype, "getClient")
          .mockResolvedValue({
            getRequestHeaders: jest
              .fn()
              .mockResolvedValue(
                new Headers({ authorization: "Bearer synthetic" }),
              ),
          } as never);
        const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              calendars: { "dispatch@example.com": { busy: [] } },
            }),
          ),
        );
        if (outcome === "credential-failure") {
          client
            .mockResolvedValueOnce({
              getRequestHeaders: jest.fn().mockResolvedValue(new Headers()),
            } as never)
            .mockRejectedValueOnce(new Error("PRIVATE_CREDENTIAL_ERROR"));
        } else if (outcome === "timeout" || outcome === "connection-loss") {
          fetchMock.mockRejectedValueOnce(
            outcome === "timeout"
              ? new DOMException("PRIVATE_PROVIDER_ERROR", "TimeoutError")
              : new Error("PRIVATE_PROVIDER_ERROR"),
          );
        } else {
          const status =
            outcome === "provider-500"
              ? 500
              : outcome === "provider-400"
                ? 400
                : 200;
          const body =
            outcome === "malformed-json"
              ? "PRIVATE_INVALID_JSON"
              : JSON.stringify({ private: "PRIVATE_PROVIDER_BODY" });
          fetchMock.mockResolvedValueOnce(new Response(body, { status }));
        }
        if (loggerFails)
          logger.error.mockImplementation(() => {
            throw new Error("PRIVATE_LOG_ERROR");
          });
        await expect(
          service.confirmAppointment({
            tenantId: baseJob.tenantId,
            jobId: baseJob.id,
            sessionId: "session-1",
            slotToken: signedSlot(start, end),
          }),
        ).rejects.toMatchObject({
          status: 503,
          message:
            "The calendar reservation needs confirmation by the office. Please contact the office before booking again.",
        });
        expect(prisma.job.updateMany).toHaveBeenCalledTimes(1);
        expect(prisma.job.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              tenantId: baseJob.tenantId,
              calendarEventId: null,
            }),
            data: expect.objectContaining({
              status: "ACCEPTED",
              serviceWindowStart: start,
              serviceWindowEnd: end,
            }),
          }),
        );
        expect(confirmation.finalize).not.toHaveBeenCalled();
        expect(
          notifications.enqueueAppointmentConfirmed,
        ).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(
          outcome === "credential-failure" ? 1 : 2,
        );
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
          "PRIVATE_",
        );
      },
    );

    it("does not reserve or insert when availability preflight fails", async () => {
      prisma.job.findFirst.mockResolvedValue(
        appointmentJob({
          status: "CREATED",
          calendarEventId: null,
          serviceWindowStart: null,
          serviceWindowEnd: null,
        }),
      );
      jest
        .spyOn(GoogleAuth.prototype, "getClient")
        .mockRejectedValue(new Error("preflight unavailable"));
      const fetchMock = jest.spyOn(global, "fetch");
      await expect(
        service.confirmAppointment({
          tenantId: baseJob.tenantId,
          jobId: baseJob.id,
          sessionId: "session-1",
          slotToken: signedSlot(new Date("2099-01-01"), new Date("2099-01-02")),
        }),
      ).rejects.toThrow();
      expect(prisma.job.updateMany).not.toHaveBeenCalled();
      expect(confirmation.finalize).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("keeps a finalized booking successful when operations notification and logging fail", async () => {
    const start = new Date("2026-09-10T15:00:00Z");
    const end = new Date("2026-09-10T18:00:00Z");
    prisma.job.findFirst.mockResolvedValue(
      appointmentJob({
        status: "CREATED",
        calendarEventId: null,
        serviceWindowStart: null,
        serviceWindowEnd: null,
      }),
    );
    prisma.job.updateMany.mockResolvedValue({ count: 1 });
    confirmation.finalize.mockResolvedValue(
      appointmentJob({ serviceWindowStart: start, serviceWindowEnd: end }),
    );
    notifications.enqueueAppointmentConfirmed.mockImplementation(() => {
      throw new Error("notification failed");
    });
    logger.error.mockImplementation(() => {
      throw new Error("logging failed");
    });
    mockCalendarInsert();
    await expect(
      service.confirmAppointment({
        tenantId: baseJob.tenantId,
        sessionId: "session-1",
        jobId: baseJob.id,
        slotToken: signedSlot(start, end),
      }),
    ).resolves.toEqual(
      expect.objectContaining({ status: "appointment_confirmed" }),
    );
    expect(prisma.job.updateMany).toHaveBeenCalledTimes(1);
  });

  function mockCalendarInsert() {
    jest.spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue({
      getRequestHeaders: jest
        .fn()
        .mockResolvedValue(new Headers({ authorization: "Bearer test" })),
    } as never);
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            calendars: { "dispatch@example.com": { busy: [] } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "event-confirmed" }), {
          status: 200,
        }),
      );
  }

  it("opens a confirmed appointment through a signed management link", async () => {
    prisma.job.findFirst.mockResolvedValue(appointmentJob());

    const result = await service.manageAppointment({
      expectedTenantId: baseJob.tenantId,
      managementToken: managementToken(),
      action: "view",
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "appointment_details",
        state: "confirmed",
        bookingState: "PENDING_CUSTOMER_CONFIRMATION",
        reference: "11111111",
        payment: {
          state: "NOT_STARTED",
          label: "Payment has not been requested",
          canContinue: false,
        },
        technician: expect.objectContaining({ state: "UNASSIGNED" }),
      }),
    );
  });

  it("rejects a valid secure link when an integration supplies a different tenant", async () => {
    await expect(
      service.manageAppointment({
        expectedTenantId: "99999999-9999-4999-8999-999999999999",
        managementToken: managementToken(),
        action: "view",
      }),
    ).rejects.toThrow("This appointment link is invalid or has expired.");
    expect(prisma.job.findFirst).not.toHaveBeenCalled();
  });

  it("authorizes payment recovery with the same signed customer link", async () => {
    prisma.job.findFirst.mockResolvedValue(
      appointmentJob({
        payment: {
          status: "PENDING",
          checkoutExpiresAt: new Date(Date.now() + 60_000),
        },
      }),
    );

    const result = await service.manageAppointment({
      managementToken: managementToken(),
      action: "continue_payment",
    });

    expect(paymentRequests.recover).toHaveBeenCalledWith(
      baseJob.tenantId,
      baseJob.id,
    );
    expect(result).toEqual(
      expect.objectContaining({ status: "payment_checkout" }),
    );
  });

  it("keeps the legacy lowercase state while exposing the richer booking state", async () => {
    prisma.job.findFirst.mockResolvedValue(
      appointmentJob({
        status: "CANCELLED",
        calendarEventId: null,
        serviceWindowStart: null,
        serviceWindowEnd: null,
      }),
    );

    const result = await service.manageAppointment({
      managementToken: managementToken(),
      action: "view",
    });

    expect(result).toEqual(
      expect.objectContaining({
        state: "cancelled",
        bookingState: "CANCELLED",
      }),
    );
  });

  it("records a customer confirmation once and returns the updated secure status", async () => {
    prisma.job.findFirst.mockResolvedValue(appointmentJob());
    prisma.auditLog.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "audit-1",
        action: "appointment.customer_confirmed",
        metadata: {},
        createdAt: new Date("2026-09-02T12:00:00.000Z"),
      },
    ]);

    const result = await service.manageAppointment({
      managementToken: managementToken(),
      action: "confirm",
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "appointment_customer_confirmed",
        bookingState: "CONFIRMED",
        changed: true,
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: baseJob.tenantId,
        action: "appointment.customer_confirmed",
        actorType: "CUSTOMER",
        entityId: baseJob.id,
      }),
    });
  });

  it("records a customer reschedule request for dispatcher follow-up", async () => {
    prisma.job.findFirst.mockResolvedValue(appointmentJob());
    prisma.auditLog.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "audit-2",
        action: "appointment.customer_reschedule_requested",
        metadata: { note: "Friday morning" },
        createdAt: new Date("2026-09-02T12:05:00.000Z"),
      },
    ]);

    const result = await service.manageAppointment({
      managementToken: managementToken(),
      action: "request_reschedule",
      note: "  Friday   morning  ",
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "appointment_reschedule_requested",
        bookingState: "RESCHEDULE_REQUESTED",
        changed: true,
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({ note: "Friday morning" }),
      }),
    });
  });

  it("reschedules the database and existing calendar event before notifying operations", async () => {
    const current = appointmentJob();
    const nextStart = new Date("2026-09-03T15:00:00.000Z");
    const nextEnd = new Date("2026-09-03T18:00:00.000Z");
    const updated = appointmentJob({
      serviceWindowStart: nextStart,
      serviceWindowEnd: nextEnd,
      preferredTimeText: "Thursday, September 3, 11:00 AM–2:00 PM",
    });
    prisma.job.findFirst
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(updated);
    prisma.job.updateMany.mockResolvedValue({ count: 1 });
    jest.spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue({
      getRequestHeaders: jest
        .fn()
        .mockResolvedValue(new Headers({ authorization: "Bearer test" })),
    } as never);
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            calendars: { "dispatch@example.com": { busy: [] } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "event-1" }), { status: 200 }),
      );

    const result = await service.manageAppointment({
      expectedTenantId: baseJob.tenantId,
      managementToken: managementToken(),
      action: "reschedule",
      slotToken: signedSlot(nextStart, nextEnd),
    });

    expect(result.status).toBe("appointment_rescheduled");
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("/events/event-1"),
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(notifications.enqueueAppointmentRescheduled).toHaveBeenCalledTimes(
      1,
    );
    expect(rescheduling.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ id: baseJob.id }),
      expect.any(String),
      expect.any(String),
    );
    expect(rescheduling.finalize.mock.invocationCallOrder[0]).toBeGreaterThan(
      fetchMock.mock.invocationCallOrder[1],
    );
  });

  it.each(["finalization", "operations", "calendar"])(
    "isolates reschedule %s failure at its correct phase",
    async (failure) => {
      prisma.job.findFirst.mockResolvedValue(appointmentJob());
      jest
        .spyOn(service as never, "fetchBusy" as never)
        .mockResolvedValue([] as never);
      const patch = jest
        .spyOn(service as never, "updateCalendarEvent" as never)
        .mockResolvedValue(undefined as never);
      if (failure === "calendar")
        patch.mockRejectedValue(new Error("unknown outcome") as never);
      if (failure === "finalization")
        rescheduling.finalize.mockRejectedValue(new Error("commit failed"));
      if (failure === "operations")
        notifications.enqueueAppointmentRescheduled.mockImplementation(() => {
          throw new Error("notification failed");
        });
      const result = service.manageAppointment({
        managementToken: managementToken(),
        action: "reschedule",
        slotToken: signedSlot(
          new Date("2026-09-03T15:00:00Z"),
          new Date("2026-09-03T18:00:00Z"),
        ),
      });
      if (failure === "operations")
        await expect(result).resolves.toEqual(
          expect.objectContaining({ status: "appointment_rescheduled" }),
        );
      else
        await expect(result).rejects.toThrow(
          failure === "calendar"
            ? "could not be confirmed"
            : "needs confirmation by the office",
        );
      expect(patch).toHaveBeenCalledTimes(1);
      if (failure === "calendar") {
        expect(rescheduling.restore).toHaveBeenCalledTimes(1);
        expect(rescheduling.finalize).not.toHaveBeenCalled();
      } else expect(rescheduling.restore).not.toHaveBeenCalled();
    },
  );

  it("requires finalization proof for a same-window reschedule replay", async () => {
    const job = appointmentJob();
    prisma.job.findFirst.mockResolvedValue(job);
    const input = {
      managementToken: managementToken(),
      action: "reschedule" as const,
      slotToken: signedSlot(job.serviceWindowStart, job.serviceWindowEnd),
    };
    rescheduling.assertFinalized.mockRejectedValue(new Error("office review"));
    await expect(service.manageAppointment(input)).rejects.toThrow(
      "office review",
    );
    rescheduling.assertFinalized.mockResolvedValue(undefined);
    await expect(service.manageAppointment(input)).resolves.toEqual(
      expect.objectContaining({ status: "appointment_rescheduled" }),
    );
    expect(rescheduling.claim).not.toHaveBeenCalled();
    expect(rescheduling.finalize).not.toHaveBeenCalled();
    expect(notifications.enqueueAppointmentRescheduled).not.toHaveBeenCalled();
  });

  it("cancels the job, deletes the calendar event and notifies operations once", async () => {
    prisma.job.findFirst
      .mockResolvedValueOnce(appointmentJob())
      .mockResolvedValueOnce(
        appointmentJob({
          status: "CANCELLED",
          calendarEventId: null,
          serviceWindowStart: null,
          serviceWindowEnd: null,
        }),
      );
    prisma.job.updateMany.mockResolvedValue({ count: 1 });
    jest.spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue({
      getRequestHeaders: jest
        .fn()
        .mockResolvedValue(new Headers({ authorization: "Bearer test" })),
    } as never);
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    const result = await service.manageAppointment({
      expectedTenantId: baseJob.tenantId,
      managementToken: managementToken(),
      action: "cancel",
    });

    expect(result.status).toBe("appointment_cancelled");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/events/event-1"),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(notifications.enqueueAppointmentCancelled).toHaveBeenCalledTimes(1);
    expect(cancellation.finalize).toHaveBeenCalledTimes(1);
    expect(cancellation.finalize.mock.invocationCallOrder[0]).toBeGreaterThan(
      fetchMock.mock.invocationCallOrder[0],
    );
    expect(rescheduling.finalize).not.toHaveBeenCalled();
  });

  it("keeps a finalized cancellation successful when operations notification fails", async () => {
    prisma.job.findFirst.mockResolvedValue(appointmentJob());
    prisma.job.updateMany.mockResolvedValue({ count: 1 });
    notifications.enqueueAppointmentCancelled.mockImplementation(() => {
      throw new Error("operations unavailable");
    });
    jest.spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue({
      getRequestHeaders: jest
        .fn()
        .mockResolvedValue(new Headers({ authorization: "Bearer test" })),
    } as never);
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      service.manageAppointment({
        managementToken: managementToken(),
        action: "cancel",
      }),
    ).resolves.toEqual(
      expect.objectContaining({ status: "appointment_cancelled" }),
    );
    expect(cancellation.logDeferred).toHaveBeenCalledWith(baseJob.id);
    expect(cancellation.restore).not.toHaveBeenCalled();
  });

  it("does not restore or notify after acknowledged deletion and failed finalization", async () => {
    prisma.job.findFirst.mockResolvedValue(appointmentJob());
    cancellation.finalize.mockRejectedValue(new Error("transaction failed"));
    jest
      .spyOn(service as never, "deleteCalendarEvent" as never)
      .mockResolvedValue(undefined as never);
    await expect(
      service.manageAppointment({
        managementToken: managementToken(),
        action: "cancel",
      }),
    ).rejects.toThrow("needs confirmation by the office");
    expect(cancellation.restore).not.toHaveBeenCalled();
    expect(notifications.enqueueAppointmentCancelled).not.toHaveBeenCalled();
    expect(rescheduling.finalize).not.toHaveBeenCalled();
  });

  it("compensates only the claimed version when calendar deletion fails and never finalizes", async () => {
    prisma.job.findFirst.mockResolvedValue(appointmentJob());
    jest
      .spyOn(service as never, "deleteCalendarEvent" as never)
      .mockRejectedValue(new Error("unknown outcome") as never);
    await expect(
      service.manageAppointment({
        managementToken: managementToken(),
        action: "cancel",
      }),
    ).rejects.toThrow("could not be confirmed");
    expect(cancellation.restore).toHaveBeenCalledTimes(1);
    expect(cancellation.finalize).not.toHaveBeenCalled();
    expect(notifications.enqueueAppointmentCancelled).not.toHaveBeenCalled();
  });

  it("requires local finalization proof for an already cancelled replay", async () => {
    prisma.job.findFirst.mockResolvedValue(
      appointmentJob({ status: "CANCELLED" }),
    );
    cancellation.assertFinalized.mockRejectedValue(new Error("office review"));
    await expect(
      service.manageAppointment({
        managementToken: managementToken(),
        action: "cancel",
      }),
    ).rejects.toThrow("office review");
    expect(cancellation.claim).not.toHaveBeenCalled();
    expect(cancellation.finalize).not.toHaveBeenCalled();
    cancellation.assertFinalized.mockResolvedValue(undefined);
    await expect(
      service.manageAppointment({
        managementToken: managementToken(),
        action: "cancel",
      }),
    ).resolves.toEqual(
      expect.objectContaining({ status: "appointment_cancelled" }),
    );
    expect(notifications.enqueueAppointmentCancelled).not.toHaveBeenCalled();
  });

  it.each([
    "view",
    "confirm",
    "request_reschedule",
    "continue_payment",
    "availability",
    "reschedule",
    "cancel",
  ] as const)(
    "holds customer %s before exposing provisional details or taking action",
    async (action) => {
      prisma.job.findFirst.mockResolvedValue(
        appointmentJob({ calendarOperations: [{ id: "pending" }] }),
      );
      await expect(
        service.manageAppointment({
          managementToken: managementToken(),
          action,
        }),
      ).rejects.toThrow("Calendar synchronization is unfinished");
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(prisma.job.updateMany).not.toHaveBeenCalled();
      expect(paymentRequests.recover).not.toHaveBeenCalled();
      expect(cancellation.claim).not.toHaveBeenCalled();
      expect(rescheduling.claim).not.toHaveBeenCalled();
    },
  );

  it("holds initial confirmation replay before Calendar access", async () => {
    const job = appointmentJob({ calendarOperations: [{ id: "pending" }] });
    prisma.job.findFirst.mockResolvedValue(job);
    await expect(
      service.confirmAppointment({
        tenantId: baseJob.tenantId,
        jobId: baseJob.id,
        sessionId: "fixture",
        slotToken: signedSlot(new Date(), new Date(Date.now() + 3600000)),
      }),
    ).rejects.toThrow("Calendar synchronization is unfinished");
    expect(confirmation.finalize).not.toHaveBeenCalled();
    expect(prisma.job.updateMany).not.toHaveBeenCalled();
  });

  it("does not audit a customer response after losing the job-version claim", async () => {
    prisma.job.findFirst.mockResolvedValue(appointmentJob());
    prisma.job.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.manageAppointment({
        managementToken: managementToken(),
        action: "confirm",
      }),
    ).rejects.toThrow("Appointment changed");
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.job.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          calendarOperations: { none: { finishedAt: null } },
        }),
      }),
    );
  });

  function managementToken(): string {
    return sign({
      version: 1,
      purpose: "appointment-management",
      tenantId: baseJob.tenantId,
      jobId: baseJob.id,
      expiresAt: Date.now() + 60_000,
    });
  }

  function signedSlot(start: Date, end: Date): string {
    return sign({
      tenantId: baseJob.tenantId,
      jobId: baseJob.id,
      start: start.toISOString(),
      end: end.toISOString(),
      expiresAt: Date.now() + 60_000,
    });
  }

  function sign(payload: Record<string, unknown>): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", config.conversationDataEncryptionKey)
      .update(encoded)
      .digest("base64url");
    return `${encoded}.${signature}`;
  }

  function appointmentJob(overrides: Record<string, unknown> = {}) {
    return {
      calendarOperations: [],
      id: baseJob.id,
      tenantId: baseJob.tenantId,
      customerId: "33333333-3333-4333-8333-333333333333",
      customer: { fullName: baseJob.customerName, phone: baseJob.phone },
      propertyAddress: { formattedAddress: baseJob.address },
      serviceCategory: { name: baseJob.issueCategory },
      urgency: baseJob.urgency,
      description: baseJob.description,
      policySnapshot: {
        propertyType: "RESIDENTIAL",
        serviceIntent: "DIAGNOSTIC",
      },
      preferredWindowLabel: null,
      preferredTimeText: "Monday, August 31, 11:00 AM–2:00 PM",
      serviceWindowStart: new Date("2026-08-31T15:00:00.000Z"),
      serviceWindowEnd: new Date("2026-08-31T18:00:00.000Z"),
      calendarEventId: "event-1",
      assignedUserId: null,
      assignedUser: null,
      technicianStatus: null,
      payment: null,
      status: "ACCEPTED",
      createdAt: new Date("2026-08-30T12:00:00.000Z"),
      updatedAt: new Date("2026-08-30T12:00:00.000Z"),
      ...overrides,
    };
  }
});
