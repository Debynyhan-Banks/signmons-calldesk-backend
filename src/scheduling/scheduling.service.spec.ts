import { createHmac } from "crypto";
import { GoogleAuth } from "google-auth-library";
import type { AppConfig } from "../config/app.config";
import type { JobNotificationService } from "../jobs/job-notification.service";
import type { JobRecord } from "../jobs/interfaces/job-repository.interface";
import type { LoggingService } from "../logging/logging.service";
import type { PrismaService } from "../prisma/prisma.service";
import { SchedulingService } from "./scheduling.service";

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
    job: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
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

  let service: SchedulingService;

  beforeEach(() => {
    jest.restoreAllMocks();
    prisma.job.findMany.mockResolvedValue([]);
    prisma.job.findFirst.mockReset();
    prisma.job.updateMany.mockReset();
    prisma.auditLog.findMany.mockReset().mockResolvedValue([]);
    prisma.auditLog.create.mockReset().mockResolvedValue({ id: "audit-1" });
    notifications.enqueueAppointmentRescheduled.mockReset();
    notifications.enqueueAppointmentCancelled.mockReset();
    service = new SchedulingService(
      prisma as unknown as PrismaService,
      notifications as unknown as JobNotificationService,
      logger as unknown as LoggingService,
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
