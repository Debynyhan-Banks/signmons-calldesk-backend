import { BadRequestException } from "@nestjs/common";
import { JobsService } from "../jobs.service";
import { SanitizationService } from "../../sanitization/sanitization.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { JobNotificationService } from "../job-notification.service";

describe("JobsService", () => {
  const tenantId = "tenant-1";
  const sessionId = "session-1";
  const rawArgs = JSON.stringify({
    customerName: "Alice",
    phone: "1234567890",
    issueCategory: "HEATING",
    urgency: "STANDARD",
  });

  const jobRecord = {
    id: "job-1",
    tenantId,
    status: "CREATED",
    urgency: "STANDARD",
    description: null,
    preferredWindowLabel: null,
    preferredTimeText: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: {
      fullName: "Alice",
      phone: "1234567890",
    },
    propertyAddress: {
      formattedAddress: "Unknown address",
    },
    serviceCategory: {
      name: "HEATING",
    },
  };

  let prisma: {
    communicationContent: { findMany: jest.Mock };
    job: { findUnique: jest.Mock; create: jest.Mock };
    customer: { upsert: jest.Mock };
    serviceCategory: { findFirst: jest.Mock; create: jest.Mock };
    propertyAddress: { create: jest.Mock };
  };
  let jobNotificationService: { notifyJobCreated: jest.Mock };
  let service: JobsService;

  beforeEach(() => {
    prisma = {
      communicationContent: {
        findMany: jest.fn(),
      },
      job: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      customer: {
        upsert: jest.fn(),
      },
      serviceCategory: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      propertyAddress: {
        create: jest.fn(),
      },
    };
    jobNotificationService = {
      notifyJobCreated: jest.fn().mockResolvedValue(undefined),
    };

    service = new JobsService(
      prisma as unknown as PrismaService,
      new SanitizationService(),
      jobNotificationService as unknown as JobNotificationService,
    );
  });

  it("returns existing job when a session already created one", async () => {
    prisma.communicationContent.findMany.mockResolvedValue([
      { payload: { jobId: jobRecord.id } },
    ] as never);
    prisma.job.findUnique.mockResolvedValue(jobRecord as never);

    const result = await service.createJobFromToolCall({
      tenantId,
      sessionId,
      rawArgs,
    });

    expect(result.id).toBe(jobRecord.id);
    expect(prisma.job.create).not.toHaveBeenCalled();
    expect(jobNotificationService.notifyJobCreated).not.toHaveBeenCalled();
  });

  it("creates a new job when no existing session job is found", async () => {
    prisma.communicationContent.findMany.mockResolvedValue([]);
    prisma.customer.upsert.mockResolvedValue({ id: "cust-1" } as never);
    prisma.serviceCategory.findFirst.mockResolvedValue(null as never);
    prisma.serviceCategory.create.mockResolvedValue({ id: "svc-1" } as never);
    prisma.propertyAddress.create.mockResolvedValue({ id: "addr-1" } as never);
    prisma.job.create.mockResolvedValue(jobRecord as never);

    const result = await service.createJobFromToolCall({
      tenantId,
      sessionId,
      rawArgs,
    });

    expect(result.id).toBe(jobRecord.id);
    expect(prisma.job.create).toHaveBeenCalled();
    expect(jobNotificationService.notifyJobCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: jobRecord.id }),
    );
  });

  it("accepts high-priority AI output without treating it as an emergency", async () => {
    prisma.communicationContent.findMany.mockResolvedValue([]);
    prisma.customer.upsert.mockResolvedValue({ id: "cust-1" } as never);
    prisma.serviceCategory.findFirst.mockResolvedValue({
      id: "svc-1",
    } as never);
    prisma.propertyAddress.create.mockResolvedValue({ id: "addr-1" } as never);
    prisma.job.create.mockResolvedValue(jobRecord as never);

    await service.createJobFromToolCall({
      tenantId,
      sessionId,
      rawArgs: JSON.stringify({
        customerName: "Alice",
        phone: "1234567890",
        issueCategory: "HEATING",
        urgency: "HIGH",
      }),
    });

    expect(prisma.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ urgency: "STANDARD" }),
      }),
    );
  });

  it("normalizes a short customer time such as 5pm to the evening window", async () => {
    prisma.communicationContent.findMany.mockResolvedValue([]);
    prisma.customer.upsert.mockResolvedValue({ id: "cust-1" } as never);
    prisma.serviceCategory.findFirst.mockResolvedValue({
      id: "svc-1",
    } as never);
    prisma.propertyAddress.create.mockResolvedValue({ id: "addr-1" } as never);
    prisma.job.create.mockResolvedValue(jobRecord as never);

    await service.createJobFromToolCall({
      tenantId,
      sessionId,
      rawArgs: JSON.stringify({
        customerName: "Alice",
        phone: "1234567890",
        issueCategory: "HEATING",
        urgency: "STANDARD",
        preferredTime: "Tomorrow at 5pm",
      }),
    });

    expect(prisma.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ preferredWindowLabel: "EVENING" }),
      }),
    );
    expect(prisma.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          preferredTimeText: "Tomorrow at 5pm",
        }),
      }),
    );
  });

  it("fails closed when required fields are missing", async () => {
    prisma.communicationContent.findMany.mockResolvedValue([]);

    await expect(
      service.createJobFromToolCall({
        tenantId,
        sessionId,
        rawArgs: JSON.stringify({ urgency: "STANDARD" }),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.job.create).not.toHaveBeenCalled();
  });

  it("fails closed when phone is invalid", async () => {
    prisma.communicationContent.findMany.mockResolvedValue([]);

    await expect(
      service.createJobFromToolCall({
        tenantId,
        sessionId,
        rawArgs: JSON.stringify({
          customerName: "Alice",
          phone: "abc",
          issueCategory: "HEATING",
          urgency: "STANDARD",
        }),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.job.create).not.toHaveBeenCalled();
  });

  it("fails closed when issueCategory is unknown", async () => {
    prisma.communicationContent.findMany.mockResolvedValue([]);

    await expect(
      service.createJobFromToolCall({
        tenantId,
        sessionId,
        rawArgs: JSON.stringify({
          customerName: "Alice",
          phone: "1234567890",
          issueCategory: "GARBAGE",
          urgency: "STANDARD",
        }),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.job.create).not.toHaveBeenCalled();
  });

  it.each([
    "sometime next week",
    "Tuesday after 3",
    "between 4 and 6",
    "anytime",
    "weekends are best",
  ])("preserves flexible preferred time wording: %s", async (preferredTime) => {
    prisma.communicationContent.findMany.mockResolvedValue([]);
    prisma.customer.upsert.mockResolvedValue({ id: "cust-1" } as never);
    prisma.serviceCategory.findFirst.mockResolvedValue({
      id: "svc-1",
    } as never);
    prisma.propertyAddress.create.mockResolvedValue({ id: "addr-1" } as never);
    prisma.job.create.mockResolvedValue({
      ...jobRecord,
      preferredTimeText: preferredTime,
    } as never);

    await service.createJobFromToolCall({
      tenantId,
      sessionId,
      rawArgs: JSON.stringify({
        customerName: "Alice",
        phone: "1234567890",
        issueCategory: "HEATING",
        urgency: "STANDARD",
        preferredTime,
      }),
    });

    expect(prisma.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ preferredTimeText: preferredTime }),
      }),
    );
  });

  it("fails closed when unexpected fields are present", async () => {
    prisma.communicationContent.findMany.mockResolvedValue([]);

    await expect(
      service.createJobFromToolCall({
        tenantId,
        sessionId,
        rawArgs: JSON.stringify({
          customerName: "Alice",
          phone: "1234567890",
          issueCategory: "HEATING",
          urgency: "STANDARD",
          extraField: "nope",
        }),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.job.create).not.toHaveBeenCalled();
  });
});
