import { NotFoundException } from "@nestjs/common";
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
      serviceWindowStart: new Date("2026-09-09T14:00:00.000Z"),
      tenant: { name: "Eternity Mechanical", timezone: "America/New_York" },
      customer: { phone: "+12165550183" },
      assignedUser: { fullName: "Jordan" },
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
});
