import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import {
  AvailabilityBlockType,
  JobStatus,
  JobUrgency,
  ProficiencyLevel,
  UserRole,
} from "@prisma/client";
import { DispatchBoardService } from "./dispatch-board.service";

describe("DispatchBoardService", () => {
  const tenantId = "059c4950-171c-4ff5-a963-20bf6b9d59a6";
  const jobId = "8ed72154-fe35-45a2-b3b5-e5218d5026f9";
  const techId = "2f2ecce7-6bb1-4aaa-a946-a660c80bb6c5";
  const now = new Date("2026-08-31T15:00:00.000Z");
  const baseJob = {
    id: jobId,
    tenantId,
    customerId: "customer-1",
    customerTenantId: tenantId,
    propertyAddressId: "address-1",
    propertyAddressTenantId: tenantId,
    serviceCategoryId: "service-1",
    serviceCategoryTenantId: tenantId,
    assignedUserId: null,
    assignedUserTenantId: null,
    status: JobStatus.ACCEPTED,
    urgency: JobUrgency.HIGH,
    description: "Furnace is not producing heat.",
    intakeSessionId: "session-1",
    pricingSnapshot: {},
    policySnapshot: {},
    preferredWindowLabel: "MORNING",
    preferredTimeText: "Tomorrow morning",
    serviceWindowStart: new Date("2026-09-01T13:00:00.000Z"),
    serviceWindowEnd: new Date("2026-09-01T15:00:00.000Z"),
    calendarEventId: "event-1",
    offerExpiresAt: null,
    acceptedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    tenant: { timezone: "America/New_York" },
    serviceCategory: { id: "service-1", name: "HEATING" },
    assignedUser: null,
  };
  const qualifiedTech = {
    id: techId,
    fullName: "Jordan Tech",
    role: UserRole.TECH,
    isAvailable: true,
    serviceCapabilities: [{ proficiency: ProficiencyLevel.EXPERT }],
    availabilityBlocks: [],
    _count: { jobs: 1 },
  };

  const createHarness = () => {
    const prisma = {
      job: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
      user: { findMany: jest.fn() },
      auditLog: { findMany: jest.fn(), create: jest.fn() },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      (callback: (transaction: typeof prisma) => unknown) =>
        Promise.resolve(callback(prisma)),
    );
    return { prisma, service: new DispatchBoardService(prisma as never) };
  };

  it("returns tenant-scoped privacy-safe queue summaries", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findMany.mockResolvedValue([baseJob]);
    prisma.auditLog.findMany.mockResolvedValue([]);

    const result = await service.list(tenantId);

    expect(prisma.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId, deletedAt: null }),
      }),
    );
    expect(result[0]).toMatchObject({
      jobId,
      queue: "READY_TO_ASSIGN",
      serviceCategory: "HEATING",
      timezone: "America/New_York",
    });
    expect(result[0]).not.toHaveProperty("customerName");
    expect(result[0]).not.toHaveProperty("phone");
    expect(result[0]).not.toHaveProperty("address");
    expect(result[0]).not.toHaveProperty("description");
  });

  it("returns an explainable deterministic recommendation", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(baseJob);
    prisma.auditLog.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "customer-audit-1",
          action: "appointment.customer_reschedule_requested",
          metadata: { note: "Friday morning" },
          createdAt: new Date("2026-08-31T15:05:00.000Z"),
        },
      ]);
    prisma.user.findMany.mockResolvedValue([
      {
        ...qualifiedTech,
        id: "40c35563-a6fd-4661-a322-68213e8f83cd",
        fullName: "Busy Tech",
        _count: { jobs: 4 },
      },
      qualifiedTech,
    ]);

    const result = await service.get(tenantId, jobId);

    expect(result.recommendation).toMatchObject({
      version: "dispatch-v2",
      technicianId: techId,
      reasonCodes: expect.arrayContaining([
        "SERVICE_MATCH",
        "AVAILABLE",
        "NO_SCHEDULE_CONFLICT",
      ]),
    });
    expect(result.candidates[0]).not.toHaveProperty("score");
    expect(result.customerBooking).toMatchObject({
      state: "RESCHEDULE_REQUESTED",
      label: "Customer requested a different appointment time",
      events: [expect.objectContaining({ note: "Friday morning" })],
    });
  });

  it("assigns the recommended technician atomically and records an audit", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValueOnce(baseJob).mockResolvedValueOnce({
      updatedAt: new Date("2026-08-31T15:01:00.000Z"),
      assignedUser: {
        id: techId,
        fullName: "Jordan Tech",
        role: UserRole.TECH,
      },
    });
    prisma.user.findMany.mockResolvedValue([qualifiedTech]);
    prisma.job.updateMany.mockResolvedValue({ count: 1 });
    prisma.auditLog.create.mockResolvedValue({ id: "audit-1" });

    const result = await service.assign({
      tenantId,
      jobId,
      technicianId: techId,
      expectedUpdatedAt: now.toISOString(),
      actorId: "dispatcher-1",
    });

    expect(result).toMatchObject({ changed: true, jobId });
    expect(prisma.job.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId, updatedAt: now }),
        data: expect.objectContaining({
          assignedUserId: techId,
          assignedUserTenantId: tenantId,
          technicianStatus: "ASSIGNED",
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId,
          action: "job.assigned",
          metadata: expect.objectContaining({
            technicianId: techId,
            recommendationVersion: "dispatch-v2",
            override: false,
          }),
        }),
      }),
    );
  });

  it("requires a reason when overriding an ineligible candidate", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(baseJob);
    prisma.user.findMany.mockResolvedValue([
      qualifiedTech,
      {
        ...qualifiedTech,
        id: "57d531d5-7764-4ec9-b927-febed839fce4",
        fullName: "Unavailable Tech",
        isAvailable: false,
        availabilityBlocks: [
          {
            type: AvailabilityBlockType.UNAVAILABLE,
            startAt: baseJob.serviceWindowStart,
            endAt: baseJob.serviceWindowEnd,
          },
        ],
      },
    ]);

    await expect(
      service.assign({
        tenantId,
        jobId,
        technicianId: "57d531d5-7764-4ec9-b927-febed839fce4",
        expectedUpdatedAt: now.toISOString(),
        actorId: "dispatcher-1",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.job.updateMany).not.toHaveBeenCalled();
  });

  it("rejects stale assignment writes without creating an audit", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(baseJob);
    prisma.user.findMany.mockResolvedValue([qualifiedTech]);
    prisma.job.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.assign({
        tenantId,
        jobId,
        technicianId: techId,
        expectedUpdatedAt: now.toISOString(),
        actorId: "dispatcher-1",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("cancels only the assignment and keeps the job active", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst
      .mockResolvedValueOnce({
        id: jobId,
        assignedUserId: techId,
        updatedAt: now,
      })
      .mockResolvedValueOnce({
        updatedAt: new Date("2026-08-31T15:01:00.000Z"),
      });
    prisma.job.updateMany.mockResolvedValue({ count: 1 });
    prisma.auditLog.create.mockResolvedValue({ id: "audit-2" });

    const result = await service.cancelAssignment({
      tenantId,
      jobId,
      expectedUpdatedAt: now.toISOString(),
      actorId: "dispatcher-1",
      reason: "Technician is no longer available.",
    });

    expect(result.changed).toBe(true);
    expect(prisma.job.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignedUserId: null,
          assignedUserTenantId: null,
          technicianStatus: null,
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "job.assignment_cancelled",
        }),
      }),
    );
  });

  it("uses the same not-found boundary for cross-tenant jobs", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(null);
    await expect(service.get("another-tenant", jobId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
