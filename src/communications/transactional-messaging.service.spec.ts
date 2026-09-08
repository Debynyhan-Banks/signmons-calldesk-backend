import { ConflictException, NotFoundException } from "@nestjs/common";
import { JobStatus, TechnicianJobStatus } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { SmsDeliveryService } from "./sms-delivery.service";
import {
  TransactionalMessageTemplateKey,
  TransactionalMessageTemplateService,
} from "./transactional-message-template.service";
import { TransactionalMessagingService } from "./transactional-messaging.service";

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
      calendarEventId: "calendar-fixture",
      serviceWindowStart: new Date("2026-09-09T14:00:00.000Z"),
      serviceWindowEnd: new Date("2026-09-09T16:00:00.000Z"),
      tenant: { name: "Eternity Mechanical", timezone: "America/New_York" },
      customer: { phone: "+12165550183" },
      assignedUser: {
        id: "20000000-0000-4000-8000-000000000002",
        fullName: "Jordan",
      },
    });
    delivery.create.mockResolvedValue({ id: "event-1", status: "QUEUED" });
  });

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
});
