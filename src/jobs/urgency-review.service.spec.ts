import { NotFoundException } from "@nestjs/common";
import { JobStatus, JobUrgency } from "@prisma/client";
import { UrgencyReviewService } from "./urgency-review.service";

describe("UrgencyReviewService", () => {
  const tenantId = "059c4950-171c-4ff5-a963-20bf6b9d59a6";
  const jobId = "8ed72154-fe35-45a2-b3b5-e5218d5026f9";
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
    status: JobStatus.CREATED,
    urgency: JobUrgency.HIGH,
    description: "Furnace is not producing heat.",
    intakeSessionId: "session-1",
    pricingSnapshot: {},
    policySnapshot: {
      propertyType: "RESIDENTIAL",
      serviceIntent: "REPAIR",
      urgencyDecision: {
        source: "AI_INTAKE",
        reasonCodes: ["TIME_SENSITIVE_SERVICE_SIGNAL"],
        confidenceNote: "Operator verification required.",
      },
    },
    preferredWindowLabel: "MORNING",
    preferredTimeText: "Tomorrow morning",
    serviceWindowStart: null,
    serviceWindowEnd: null,
    calendarEventId: null,
    offerExpiresAt: null,
    acceptedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    customer: {
      fullName: "Test Banks",
      phone: "2165550111",
    },
    propertyAddress: { formattedAddress: "123 Test Street" },
    serviceCategory: { name: "HEATING" },
  };

  const createHarness = () => {
    const prisma = {
      job: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      auditLog: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      (callback: (transaction: typeof prisma) => unknown) =>
        Promise.resolve(callback(prisma)),
    );
    const notifications = {
      notifyUrgencyEscalation: jest.fn(),
    };
    return {
      prisma,
      notifications,
      service: new UrgencyReviewService(
        prisma as never,
        notifications as never,
      ),
    };
  };

  it("returns privacy-safe rationale and orders higher urgency first", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findMany.mockResolvedValue([
      { ...baseJob, urgency: JobUrgency.STANDARD },
      { ...baseJob, id: "emergency-job", urgency: JobUrgency.EMERGENCY },
    ]);

    const results = await service.list(tenantId);

    expect(results[0]).toMatchObject({
      jobId: "emergency-job",
      urgency: "EMERGENCY",
    });
    expect(results[1].rationale).toMatchObject({
      decisionSource: "AI_INTAKE",
      reasonCodes: ["TIME_SENSITIVE_SERVICE_SIGNAL"],
    });
    expect(results[1]).not.toHaveProperty("customerName");
    expect(results[1]).not.toHaveProperty("phone");
    expect(results[1]).not.toHaveProperty("address");
  });

  it("updates urgency and records the mandatory reason atomically", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(baseJob);
    prisma.job.update.mockResolvedValue({ ...baseJob, urgency: "EMERGENCY" });
    prisma.auditLog.create.mockResolvedValue({ id: "audit-1", createdAt: now });

    const result = await service.override({
      tenantId,
      jobId,
      actorId: "dispatcher-1",
      urgency: "EMERGENCY",
      reason: "Customer reported a qualifying safety condition.",
    });

    expect(prisma.job.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ urgency: "EMERGENCY" }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "job.urgency_overridden",
          actorId: "dispatcher-1",
          metadata: expect.objectContaining({
            previousUrgency: "HIGH",
            urgency: "EMERGENCY",
            reason: "Customer reported a qualifying safety condition.",
          }),
        }),
      }),
    );
    expect(result).toMatchObject({ changed: true, urgency: "EMERGENCY" });
  });

  it("does not duplicate audit history for a same-value override", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(baseJob);

    const result = await service.override({
      tenantId,
      jobId,
      actorId: "dispatcher-1",
      urgency: "HIGH",
      reason: "Confirmed existing high priority classification.",
    });

    expect(result).toMatchObject({ changed: false, override: null });
    expect(prisma.job.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("records truthful escalation delivery outcomes", async () => {
    const { prisma, notifications, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(baseJob);
    notifications.notifyUrgencyEscalation.mockResolvedValue([
      {
        channel: "internal",
        recipientGroup: "operations",
        outcome: "not_configured",
      },
    ]);
    prisma.auditLog.create.mockResolvedValue({ id: "audit-2", createdAt: now });

    const result = await service.escalate({
      tenantId,
      jobId,
      actorId: "owner-1",
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "job.urgency_escalated",
          metadata: expect.objectContaining({
            recipientGroup: "operations",
            deliveries: [
              expect.objectContaining({ outcome: "not_configured" }),
            ],
          }),
        }),
      }),
    );
    expect(result.escalation.deliveries[0].outcome).toBe("not_configured");
  });

  it("suppresses duplicate escalation delivery attempts for five minutes", async () => {
    const { prisma, notifications, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(baseJob);
    prisma.auditLog.findFirst.mockResolvedValue({
      id: "audit-existing",
      actorId: "owner-1",
      metadata: {
        deliveries: [
          {
            channel: "email",
            recipientGroup: "operations",
            outcome: "delivered",
          },
        ],
      },
      createdAt: now,
    });

    const result = await service.escalate({
      tenantId,
      jobId,
      actorId: "dispatcher-1",
    });

    expect(result.changed).toBe(false);
    expect(notifications.notifyUrgencyEscalation).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("uses the same not-found boundary for missing or cross-tenant jobs", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(null);

    await expect(service.get("another-tenant", jobId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
