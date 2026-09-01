import { ConflictException, NotFoundException } from "@nestjs/common";
import {
  JobStatus,
  JobUrgency,
  TechnicianJobStatus,
  UserRole,
} from "@prisma/client";
import { TechnicianWorkflowService } from "./technician-workflow.service";

describe("TechnicianWorkflowService", () => {
  const tenantId = "059c4950-171c-4ff5-a963-20bf6b9d59a6";
  const technicianId = "2f2ecce7-6bb1-4aaa-a946-a660c80bb6c5";
  const jobId = "8ed72154-fe35-45a2-b3b5-e5218d5026f9";
  const now = new Date("2026-08-31T18:00:00.000Z");
  const access = { tenantId, technicianId, expiresAt: new Date("2026-09-03") };
  const technician = {
    id: technicianId,
    fullName: "Jordan Tech",
    role: UserRole.TECH,
    tenant: { timezone: "America/New_York" },
  };
  const baseJob = {
    id: jobId,
    tenantId,
    customerId: "customer-1",
    customerTenantId: tenantId,
    propertyAddressId: "address-1",
    propertyAddressTenantId: tenantId,
    serviceCategoryId: "service-1",
    serviceCategoryTenantId: tenantId,
    assignedUserId: technicianId,
    assignedUserTenantId: tenantId,
    status: JobStatus.ACCEPTED,
    technicianStatus: TechnicianJobStatus.ASSIGNED,
    technicianStatusUpdatedAt: now,
    urgency: JobUrgency.HIGH,
    description: "Furnace is not producing heat.",
    intakeSessionId: "session-1",
    pricingSnapshot: {},
    policySnapshot: {},
    preferredWindowLabel: "AFTERNOON",
    preferredTimeText: "Today at 3pm",
    serviceWindowStart: new Date("2026-08-31T19:00:00.000Z"),
    serviceWindowEnd: new Date("2026-08-31T21:00:00.000Z"),
    calendarEventId: "event-1",
    offerExpiresAt: null,
    acceptedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    customer: {
      fullName: "Casey Customer",
      phone: "2165550100",
      email: "casey@example.com",
    },
    propertyAddress: {
      formattedAddress: "100 Main St, Cleveland, OH",
      accessNotes: "Side door",
    },
    serviceCategory: { name: "Heating" },
  };

  const createHarness = () => {
    const prisma = {
      user: { findFirst: jest.fn().mockResolvedValue(technician) },
      job: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      (callback: (transaction: typeof prisma) => unknown) =>
        Promise.resolve(callback(prisma)),
    );
    const links = { verify: jest.fn().mockReturnValue(access) };
    return {
      prisma,
      links,
      service: new TechnicianWorkflowService(prisma as never, links as never),
    };
  };

  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it("lists only the linked technician's tenant-scoped assignments", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findMany.mockResolvedValue([baseJob]);

    const result = await service.list("signed-link");

    expect(prisma.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId,
          assignedUserId: technicianId,
          assignedUserTenantId: tenantId,
          deletedAt: null,
        }),
      }),
    );
    expect(result.groups.today[0]).toMatchObject({
      jobId,
      technicianStatus: TechnicianJobStatus.ASSIGNED,
      availableActions: ["accept", "decline", "cannot_take"],
    });
    expect(result.groups.today[0]).not.toHaveProperty("customer");
  });

  it("returns customer details only for an assigned job", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(baseJob);

    await expect(service.get("signed-link", jobId)).resolves.toMatchObject({
      jobId,
      customer: { fullName: "Casey Customer", phone: "2165550100" },
      serviceAddress: "100 Main St, Cleveland, OH",
    });
    expect(prisma.job.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: jobId,
          tenantId,
          assignedUserId: technicianId,
        }),
      }),
    );
  });

  it("uses the same not-found boundary for another technician's job", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(null);
    await expect(service.get("signed-link", jobId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("accepts an assignment atomically and records a privacy-safe audit", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValueOnce(baseJob).mockResolvedValueOnce({
      ...baseJob,
      technicianStatus: TechnicianJobStatus.ACCEPTED,
      updatedAt: new Date("2026-08-31T18:01:00.000Z"),
    });
    prisma.job.updateMany.mockResolvedValue({ count: 1 });
    prisma.auditLog.create.mockResolvedValue({ id: "audit-1" });

    const result = await service.update({
      rawToken: "signed-link",
      jobId,
      action: "accept",
      expectedUpdatedAt: now.toISOString(),
    });

    expect(result).toMatchObject({
      changed: true,
      technicianStatus: "ACCEPTED",
    });
    expect(prisma.job.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId,
          assignedUserId: technicianId,
          updatedAt: now,
        }),
        data: expect.objectContaining({
          technicianStatus: TechnicianJobStatus.ACCEPTED,
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId,
          action: "job.technician_accepted",
          actorId: technicianId,
          metadata: expect.not.objectContaining({
            customerName: expect.anything(),
            phone: expect.anything(),
          }),
        }),
      }),
    );
  });

  it("returns an unavailable assignment to dispatch without closing the job", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(baseJob);
    prisma.job.updateMany.mockResolvedValue({ count: 1 });
    prisma.auditLog.create.mockResolvedValue({ id: "audit-2" });

    const result = await service.update({
      rawToken: "signed-link",
      jobId,
      action: "cannot_take",
      expectedUpdatedAt: now.toISOString(),
    });

    expect(result).toMatchObject({
      changed: true,
      assignmentReleased: true,
      action: "cannot_take",
    });
    expect(prisma.job.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignedUserId: null,
          assignedUserTenantId: null,
          technicianStatus: null,
        }),
      }),
    );
  });

  it("rejects stale mobile writes without an audit", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(baseJob);
    prisma.job.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.update({
        rawToken: "signed-link",
        jobId,
        action: "accept",
        expectedUpdatedAt: now.toISOString(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects invalid lifecycle jumps", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(baseJob);

    await expect(
      service.update({
        rawToken: "signed-link",
        jobId,
        action: "complete",
        expectedUpdatedAt: now.toISOString(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.job.updateMany).not.toHaveBeenCalled();
  });
});
