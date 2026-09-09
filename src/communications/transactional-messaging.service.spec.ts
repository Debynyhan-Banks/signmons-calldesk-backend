import { ConflictException, NotFoundException } from "@nestjs/common";
import { JobStatus, TechnicianJobStatus } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import { CalendarOperationPendingError } from "../scheduling/calendar-operation-guard";
import type { SmsDeliveryService } from "./sms-delivery.service";
import {
  transactionalMessageStateHash,
  type TransactionalMessageJob,
} from "./transactional-message-state";
import {
  TransactionalMessageTemplateKey,
  TransactionalMessageTemplateService,
} from "./transactional-message-template.service";
import {
  StaleMessageIntentError,
  TransactionalMessagingService,
} from "./transactional-messaging.service";

describe("TransactionalMessagingService", () => {
  const tenantId = "8cf1e75e-14e7-4d4f-afd1-b4416a832ba1";
  const jobId = "10000000-0000-4000-8000-000000000001";
  const prisma = { job: { findUnique: jest.fn() } };
  const delivery = { create: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.job.findUnique.mockResolvedValue({
      id: jobId,
      status: JobStatus.ACCEPTED,
      deletedAt: null,
      technicianStatus: TechnicianJobStatus.ACCEPTED,
      technicianStatusUpdatedAt: new Date("2026-09-09T13:00:00.000Z"),
      calendarEventId: "calendar-fixture",
      serviceWindowStart: new Date("2026-09-09T14:00:00.000Z"),
      serviceWindowEnd: new Date("2026-09-09T16:00:00.000Z"),
      calendarOperations: [],
      tenant: {
        settings: {},
        name: "Eternity Mechanical",
        timezone: "America/New_York",
      },
      customer: { phone: "+12165550183" },
      assignedUser: {
        id: "20000000-0000-4000-8000-000000000002",
        fullName: "Jordan",
      },
    });
    delivery.create.mockResolvedValue({ id: "event-1", status: "QUEUED" });
  });

  it.each(Object.values(TransactionalMessageTemplateKey))(
    "rejects manual %s and defers stale-looking recovery while Calendar is pending",
    async (templateKey) => {
      const job = await prisma.job.findUnique();
      prisma.job.findUnique.mockResolvedValue({
        ...job,
        calendarOperations: [{ id: "pending" }],
      });
      const input = { tenantId, jobId, templateKey, idempotencyKey: "fixture" };
      await expect(createService().queue(input)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(
        createService().queueLifecycle({
          ...input,
          expectedStateHash: "f".repeat(64),
        }),
      ).rejects.toBeInstanceOf(CalendarOperationPendingError);
      expect(delivery.create).not.toHaveBeenCalled();
    },
  );

  it.each(Object.values(TransactionalMessageTemplateKey))(
    "holds legacy %s at manual and lifecycle admission even with a matching hash",
    async (templateKey) => {
      const job = {
        ...((await prisma.job.findUnique()) as TransactionalMessageJob),
        calendarEventId: null,
        technicianStatus: TechnicianJobStatus.EN_ROUTE,
      };
      prisma.job.findUnique.mockResolvedValue(job);
      const input = { tenantId, jobId, templateKey, idempotencyKey: "legacy" };
      await expect(createService().queue(input)).rejects.toBeInstanceOf(
        ConflictException,
      );
      for (const expectedStateHash of [
        undefined,
        "f".repeat(64),
        transactionalMessageStateHash(templateKey, job),
      ]) {
        await expect(
          createService().queueLifecycle({ ...input, expectedStateHash }),
        ).rejects.toBeInstanceOf(CalendarOperationPendingError);
      }
      expect(delivery.create).not.toHaveBeenCalled();
    },
  );

  it.each(Object.values(TransactionalMessageTemplateKey))(
    "blocks %s queue admission when tenant preferences disable it",
    async (templateKey) => {
      const job = (await prisma.job.findUnique()) as TransactionalMessageJob;
      prisma.job.findUnique.mockResolvedValue({
        ...job,
        status: "CANCELLED",
        tenant: {
          ...job.tenant,
          settings: {
            customerSmsPreferences: {
              version: 1,
              events: Object.fromEntries(
                Object.values(TransactionalMessageTemplateKey).map((key) => [
                  key,
                  false,
                ]),
              ),
            },
          },
        },
      });
      await expect(
        createService().queue({
          tenantId,
          jobId,
          templateKey,
          idempotencyKey: "preference",
        }),
      ).rejects.toThrow("disabled by tenant");
      expect(delivery.create).not.toHaveBeenCalled();
    },
  );

  it("loads the job inside the tenant boundary and queues encrypted delivery", async () => {
    const service = createService();
    await expect(
      service.queue({
        tenantId,
        jobId,
        templateKey: TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED,
        idempotencyKey: "appointment-confirmed:1",
      }),
    ).resolves.toEqual({ id: "event-1", status: "QUEUED" });

    expect(prisma.job.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id_tenantId: { id: jobId, tenantId } },
      }),
    );
    expect(delivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        jobId,
        to: "+12165550183",
        templateId: "transactional_sms:appointment_confirmed:v1",
        lifecycleStateHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it("derives one canonical idempotency identity from the committed lifecycle state", async () => {
    await createService().queueLifecycle({
      tenantId,
      jobId,
      templateKey: TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED,
    });

    expect(delivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^lifecycle:APPOINTMENT_CONFIRMED:[0-9a-f]{64}$/,
        ),
      }),
    );
  });

  it("does not disclose cross-tenant or missing jobs", async () => {
    prisma.job.findUnique.mockResolvedValue(null);
    await expect(
      createService().queue({
        tenantId,
        jobId,
        templateKey: TransactionalMessageTemplateKey.APPOINTMENT_CANCELLED,
        idempotencyKey: "appointment-cancelled:1",
      }),
    ).rejects.toThrow(NotFoundException);
    expect(delivery.create).not.toHaveBeenCalled();
  });

  function createService() {
    return new TransactionalMessagingService(
      prisma as unknown as PrismaService,
      new TransactionalMessageTemplateService(),
      delivery as unknown as SmsDeliveryService,
    );
  }

  it("rejects recovery when the recorded state no longer matches", async () => {
    await expect(
      createService().queueLifecycle({
        tenantId,
        jobId,
        templateKey: TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED,
        expectedStateHash: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(StaleMessageIntentError);
    expect(delivery.create).not.toHaveBeenCalled();
  });

  it("treats missing jobs as stale during intent recovery", async () => {
    prisma.job.findUnique.mockResolvedValue(null);
    await expect(
      createService().queueLifecycle({
        tenantId,
        jobId,
        templateKey: TransactionalMessageTemplateKey.TECHNICIAN_ON_THE_WAY,
        expectedStateHash: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(StaleMessageIntentError);
    expect(delivery.create).not.toHaveBeenCalled();
  });

  it("treats soft-deleted jobs as missing without queue access", async () => {
    const job = await prisma.job.findUnique();
    prisma.job.findUnique.mockResolvedValue({ ...job, deletedAt: new Date() });
    await expect(
      queue(TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED),
    ).rejects.toThrow(NotFoundException);
    expect(delivery.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      TransactionalMessageTemplateKey.APPOINTMENT_CANCELLED,
      { status: JobStatus.ACCEPTED },
    ],
    [
      TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED,
      { status: JobStatus.CANCELLED },
    ],
    [
      TransactionalMessageTemplateKey.APPOINTMENT_RESCHEDULED,
      { status: JobStatus.COMPLETED },
    ],
    [
      TransactionalMessageTemplateKey.TECHNICIAN_ON_THE_WAY,
      {
        status: JobStatus.CANCELLED,
        technicianStatus: TechnicianJobStatus.EN_ROUTE,
      },
    ],
    [
      TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED,
      { calendarEventId: null },
    ],
    [
      TransactionalMessageTemplateKey.APPOINTMENT_RESCHEDULED,
      { serviceWindowStart: null },
    ],
    [
      TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED,
      { serviceWindowEnd: null },
    ],
    [
      TransactionalMessageTemplateKey.APPOINTMENT_RESCHEDULED,
      { serviceWindowEnd: new Date("2026-09-09T13:00:00.000Z") },
    ],
    [
      TransactionalMessageTemplateKey.TECHNICIAN_ON_THE_WAY,
      { technicianStatus: TechnicianJobStatus.ACCEPTED },
    ],
    [
      TransactionalMessageTemplateKey.TECHNICIAN_ON_THE_WAY,
      { technicianStatus: TechnicianJobStatus.EN_ROUTE, assignedUser: null },
    ],
  ])(
    "rejects %s when stored job state conflicts: %j",
    async (key, override) => {
      const job = await prisma.job.findUnique();
      prisma.job.findUnique.mockResolvedValue({ ...job, ...override });
      await expect(queue(key)).rejects.toThrow(ConflictException);
      expect(delivery.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      TransactionalMessageTemplateKey.APPOINTMENT_CANCELLED,
      {
        status: JobStatus.CANCELLED,
        calendarEventId: null,
        serviceWindowStart: null,
        serviceWindowEnd: null,
      },
    ],
    [
      TransactionalMessageTemplateKey.TECHNICIAN_ON_THE_WAY,
      { technicianStatus: TechnicianJobStatus.EN_ROUTE },
    ],
    [TransactionalMessageTemplateKey.APPOINTMENT_RESCHEDULED, {}],
  ])(
    "allows %s when stored state supports the message",
    async (key, override) => {
      const job = await prisma.job.findUnique();
      prisma.job.findUnique.mockResolvedValue({ ...job, ...override });
      await expect(queue(key)).resolves.toEqual({
        id: "event-1",
        status: "QUEUED",
      });
      expect(delivery.create).toHaveBeenCalledTimes(1);
    },
  );

  function queue(templateKey: TransactionalMessageTemplateKey) {
    return createService().queue({
      tenantId,
      jobId,
      templateKey,
      idempotencyKey: "state-check:1",
    });
  }

  it("deduplicates one en-route episode but distinguishes a later departure by the same technician", async () => {
    const job = await prisma.job.findUnique();
    const enRoute = { ...job, technicianStatus: TechnicianJobStatus.EN_ROUTE };
    prisma.job.findUnique.mockResolvedValue(enRoute);
    const input = {
      tenantId,
      jobId,
      templateKey: TransactionalMessageTemplateKey.TECHNICIAN_ON_THE_WAY,
    };
    await createService().queueLifecycle(input);
    await createService().queueLifecycle(input);
    const calls = delivery.create.mock.calls as [
      Parameters<SmsDeliveryService["create"]>[0],
    ][];
    const first = calls[0][0];
    expect(calls[1][0].idempotencyKey).toBe(first.idempotencyKey);
    prisma.job.findUnique.mockResolvedValue({
      ...enRoute,
      technicianStatusUpdatedAt: new Date("2026-09-09T15:00:00.000Z"),
    });
    await createService().queueLifecycle(input);
    expect(calls[2][0].idempotencyKey).not.toBe(first.idempotencyKey);
    expect(calls[2][0].lifecycleStateHash).not.toBe(first.lifecycleStateHash);
  });
});
