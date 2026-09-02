import { NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  JobUrgency,
  RoutingRuleStatus,
  RoutingTimeScope,
  ServiceAreaStatus,
  ServiceAreaType,
  UserRole,
} from "@prisma/client";
import { SaveRoutingRuleDto } from "./dto/save-routing-rule.dto";
import { SaveServiceAreaDto } from "./dto/save-service-area.dto";
import { RoutingService } from "./routing.service";

describe("RoutingService", () => {
  const tenantId = "059c4950-171c-4ff5-a963-20bf6b9d59a6";
  const jobId = "8ed72154-fe35-45a2-b3b5-e5218d5026f9";
  const baseJob = {
    id: jobId,
    urgency: JobUrgency.EMERGENCY,
    serviceCategoryId: "service-1",
    serviceWindowStart: new Date("2026-09-02T15:00:00.000Z"),
    tenant: { timezone: "America/New_York" },
    propertyAddress: {
      addressComponents: { postalCode: "44119" },
      formattedAddress: "20991 Recher Ave, Euclid, OH 44119",
    },
  };
  const rule = {
    id: "rule-1",
    tenantId,
    name: "Emergency Cleveland routing",
    status: RoutingRuleStatus.ACTIVE,
    priority: 10,
    serviceCategoryId: "service-1",
    urgency: JobUrgency.EMERGENCY,
    timeScope: RoutingTimeScope.BUSINESS_HOURS,
    requireAvailable: true,
    requireOnCall: true,
    escalateToOwner: true,
    escalateToOnCall: true,
    serviceArea: {
      status: ServiceAreaStatus.ACTIVE,
      type: ServiceAreaType.ZIP,
      definition: { postalCodes: ["44119", "44123"] },
    },
  };

  const harness = () => {
    const prisma = {
      job: { findFirst: jest.fn().mockResolvedValue(baseJob) },
      routingRule: {
        findMany: jest.fn().mockResolvedValue([rule]),
        create: jest.fn(),
        update: jest.fn(),
      },
      serviceArea: { create: jest.fn(), update: jest.fn() },
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "owner-1",
            fullName: "Owner",
            role: UserRole.OWNER,
            isOnCall: false,
          },
          {
            id: "tech-1",
            fullName: "On Call",
            role: UserRole.TECH,
            isOnCall: true,
          },
        ]),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: "audit-1" }) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      (callback: (transaction: typeof prisma) => unknown) =>
        Promise.resolve(callback(prisma)),
    );
    return { prisma, service: new RoutingService(prisma as never) };
  };

  it("matches service area and returns owner plus on-call emergency escalation", async () => {
    const { service } = harness();
    const result = await service.evaluateJob(tenantId, jobId);
    expect(result).toMatchObject({
      covered: true,
      postalCode: "44119",
      matchedRule: { id: "rule-1", priority: 10 },
      requirements: { requireAvailable: true, requireOnCall: true },
    });
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        "ROUTING_RULE_MATCHED",
        "SERVICE_AREA_MATCHED",
        "OWNER_ESCALATION",
        "ON_CALL_ESCALATION",
      ]),
    );
    expect(result.escalationPath).toHaveLength(2);
  });

  it("blocks dispatch when applicable rules exclude the address", async () => {
    const { prisma, service } = harness();
    prisma.job.findFirst.mockResolvedValue({
      ...baseJob,
      propertyAddress: {
        ...baseJob.propertyAddress,
        addressComponents: { postalCode: "44060" },
      },
    });
    const result = await service.evaluateJob(tenantId, jobId);
    expect(result.covered).toBe(false);
    expect(result.matchedRule).toBeNull();
    expect(result.reasonCodes).toContain("SERVICE_AREA_OUT_OF_COVERAGE");
  });

  it("audit logs an explicit evaluation with its reason trace", async () => {
    const { prisma, service } = harness();
    await service.evaluateAndAudit({
      tenantId,
      jobId,
      actorId: "dispatcher-1",
      traceId: "trace-1",
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId,
        action: "routing.rule_evaluated",
        entityType: "Job",
        entityId: jobId,
        metadata: expect.objectContaining({
          covered: true,
          version: "routing-v1",
        }),
      }),
    });
  });

  it("uses the same not-found boundary for missing or cross-tenant rule updates", async () => {
    const { prisma, service } = harness();
    prisma.routingRule.update.mockRejectedValue({ code: "P2025" });

    await expect(
      service.saveRule({
        tenantId,
        ruleId: "77c939cd-b40f-4636-96bd-1f336f62a516",
        actorId: "dispatcher-1",
        dto: {
          name: "After-hours routing",
          status: RoutingRuleStatus.ACTIVE,
          priority: 10,
          timeScope: RoutingTimeScope.AFTER_HOURS,
          requireAvailable: true,
          requireOnCall: true,
          escalateToOwner: true,
          escalateToOnCall: true,
        },
      }),
    ).rejects.toThrow(new NotFoundException("Routing rule was not found."));
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("uses the same not-found boundary for missing or cross-tenant service-area updates", async () => {
    const { prisma, service } = harness();
    prisma.serviceArea.update.mockRejectedValue({ code: "P2025" });

    await expect(
      service.saveServiceArea({
        tenantId,
        serviceAreaId: "d98ee344-b30a-4f4b-8fae-0e570730741b",
        actorId: "dispatcher-1",
        dto: {
          name: "Greater Cleveland core",
          status: ServiceAreaStatus.ACTIVE,
          postalCodes: ["44119"],
        },
      }),
    ).rejects.toThrow(new NotFoundException("Service area was not found."));
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only routing-rule and service-area names", async () => {
    const ruleErrors = await validate(
      plainToInstance(SaveRoutingRuleDto, {
        name: "   ",
        status: RoutingRuleStatus.ACTIVE,
        priority: 10,
        timeScope: RoutingTimeScope.ANY,
        requireAvailable: true,
        requireOnCall: false,
        escalateToOwner: false,
        escalateToOnCall: false,
      }),
    );
    const areaErrors = await validate(
      plainToInstance(SaveServiceAreaDto, {
        name: "   ",
        status: ServiceAreaStatus.ACTIVE,
        postalCodes: ["44119"],
      }),
    );

    expect(ruleErrors).toHaveLength(1);
    expect(areaErrors).toHaveLength(1);
  });
});
