import { NotFoundException } from "@nestjs/common";
import { AuditActorType, JobStatus, JobUrgency } from "@prisma/client";
import { IntakeReadinessService } from "./intake-readiness.service";

describe("IntakeReadinessService", () => {
  const tenantId = "059c4950-171c-4ff5-a963-20bf6b9d59a6";
  const jobId = "8ed72154-fe35-45a2-b3b5-e5218d5026f9";
  const createdAt = new Date("2026-08-31T15:00:00.000Z");
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
    urgency: JobUrgency.STANDARD,
    description: "Furnace is not producing heat.",
    intakeSessionId: "session-1",
    pricingSnapshot: {},
    policySnapshot: { propertyType: "RESIDENTIAL" },
    preferredWindowLabel: "MORNING",
    preferredTimeText: "Tomorrow morning",
    serviceWindowStart: null,
    serviceWindowEnd: null,
    calendarEventId: null,
    offerExpiresAt: null,
    acceptedAt: null,
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    customer: {
      id: "customer-1",
      tenantId,
      phone: "2165550111",
      fullName: "Test Banks",
      email: null,
      aiMetadata: null,
      consentToText: false,
      consentToTextAt: null,
      marketingOptIn: false,
      marketingOptInAt: null,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    },
    propertyAddress: {
      id: "address-1",
      tenantId,
      customerId: "customer-1",
      customerTenantId: tenantId,
      googlePlaceId: "place-1",
      formattedAddress: "123 Test Street, Cleveland, OH",
      addressComponents: {},
      latitude: 41.5,
      longitude: -81.6,
      accessNotes: null,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    },
    serviceCategory: {
      id: "service-1",
      tenantId,
      name: "HEATING",
      description: null,
      status: "ACTIVE",
      createdAt,
      updatedAt: createdAt,
    },
    payment: null,
  };

  const createHarness = () => {
    const prisma = {
      job: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      communicationContent: { findMany: jest.fn() },
      auditLog: {
        findMany: jest.fn(),
        create: jest.fn(),
      },
    };
    return {
      prisma,
      service: new IntakeReadinessService(prisma as never),
    };
  };

  it("returns a tenant-scoped ready intake and visibly flags emergencies", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findMany.mockResolvedValue([
      { ...baseJob, urgency: JobUrgency.EMERGENCY },
    ]);

    const [result] = await service.list(tenantId);

    expect(prisma.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId, deletedAt: null } }),
    );
    expect(result).toMatchObject({
      jobId,
      customerName: "Test Banks",
      priority: "EMERGENCY",
      readiness: { state: "READY_TO_ASSIGN", missingFields: [] },
    });
  });

  it("lists every required missing field and enforces a required deposit", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findMany.mockResolvedValue([
      {
        ...baseJob,
        customer: {
          ...baseJob.customer,
          fullName: "Unknown Caller",
          phone: "unknown-session-1",
        },
        propertyAddress: {
          ...baseJob.propertyAddress,
          formattedAddress: "Unknown address",
        },
        serviceCategory: { ...baseJob.serviceCategory, name: "" },
        description: null,
        preferredWindowLabel: null,
        preferredTimeText: null,
        policySnapshot: { depositRequired: true },
      },
    ]);

    const [result] = await service.list(tenantId);

    expect(result.readiness).toEqual(
      expect.objectContaining({
        state: "MISSING_INFO",
        missingFields: [
          "customerName",
          "phone",
          "serviceAddress",
          "serviceCategory",
          "issueSummary",
          "preferredWindow",
          "paymentStatus",
        ],
      }),
    );
  });

  it("uses the shared fail-closed gate for a required service fee", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findMany.mockResolvedValue([
      {
        ...baseJob,
        policySnapshot: { serviceFeeRequired: true },
        payment: null,
      },
    ]);

    const [result] = await service.list(tenantId);

    expect(result.paymentStatus).toBe("NOT_REQUESTED");
    expect(result.readiness.missingFields).toContain("paymentStatus");
  });

  it("returns the linked session trace and prior readiness reviews", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(baseJob);
    prisma.communicationContent.findMany.mockResolvedValue([
      {
        id: "message-1",
        payload: { type: "message", role: "user", message: "No heat." },
        createdAt,
      },
    ]);
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: "audit-1",
        actorId: "dispatcher-1",
        metadata: { state: "READY_TO_ASSIGN", missingFields: [] },
        createdAt,
      },
    ]);

    const result = await service.get(tenantId, jobId);

    expect(prisma.communicationContent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId }),
      }),
    );
    expect(result.transcript).toEqual([
      {
        id: "message-1",
        role: "caller",
        content: "No heat.",
        occurredAt: createdAt.toISOString(),
      },
    ]);
    expect(result.reviewHistory[0]).toMatchObject({
      state: "READY_TO_ASSIGN",
      actorId: "dispatcher-1",
    });
  });

  it("writes a PII-free audit record for the computed readiness decision", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(baseJob);
    prisma.auditLog.create.mockResolvedValue({ id: "audit-1", createdAt });

    const result = await service.review({
      tenantId,
      jobId,
      actorId: "dispatcher-1",
      traceId: "trace-1",
    });

    expect(result.readiness.state).toBe("READY_TO_ASSIGN");
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId,
        action: "job.intake_readiness_reviewed",
        actorType: AuditActorType.USER,
        actorId: "dispatcher-1",
        entityId: jobId,
        metadata: { state: "READY_TO_ASSIGN", missingFields: [] },
      }),
      select: { id: true, createdAt: true },
    });
    expect(JSON.stringify(prisma.auditLog.create.mock.calls[0])).not.toContain(
      "Test Banks",
    );
  });

  it("uses the same not-found boundary for missing and cross-tenant jobs", async () => {
    const { prisma, service } = createHarness();
    prisma.job.findFirst.mockResolvedValue(null);

    await expect(service.get(tenantId, jobId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.job.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: jobId, tenantId, deletedAt: null },
      }),
    );
  });
});
