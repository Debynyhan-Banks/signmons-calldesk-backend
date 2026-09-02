import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  AuditActorType,
  JobUrgency,
  Prisma,
  RoutingRuleStatus,
  RoutingTimeScope,
  ServiceAreaStatus,
  ServiceAreaType,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigureTechnicianRoutingDto } from "./dto/configure-technician-routing.dto";
import { SaveRoutingRuleDto } from "./dto/save-routing-rule.dto";
import { SaveServiceAreaDto } from "./dto/save-service-area.dto";

type PrismaClient = Prisma.TransactionClient | PrismaService;

export interface RoutingEvaluation {
  version: "routing-v1";
  jobId: string;
  timeScope: "BUSINESS_HOURS" | "AFTER_HOURS";
  postalCode: string | null;
  covered: boolean;
  matchedRule: {
    id: string;
    name: string;
    priority: number;
  } | null;
  requirements: {
    requireAvailable: boolean;
    requireOnCall: boolean;
  };
  reasonCodes: string[];
  reasons: string[];
  escalationPath: Array<{
    userId: string;
    fullName: string;
    role: string;
    reason: "OWNER" | "ON_CALL";
  }>;
}

@Injectable()
export class RoutingService {
  constructor(private readonly prisma: PrismaService) {}

  async snapshot(tenantId: string) {
    const [rules, serviceAreas, technicians, serviceCategories] =
      await Promise.all([
        this.prisma.routingRule.findMany({
          where: { tenantId },
          include: {
            serviceCategory: { select: { id: true, name: true } },
            serviceArea: { select: { id: true, name: true } },
          },
          orderBy: [{ priority: "asc" }, { name: "asc" }],
        }),
        this.prisma.serviceArea.findMany({
          where: { tenantId },
          orderBy: { name: "asc" },
        }),
        this.prisma.user.findMany({
          where: { tenantId, status: UserStatus.ACTIVE, role: UserRole.TECH },
          select: {
            id: true,
            fullName: true,
            isAvailable: true,
            isOnCall: true,
            serviceCapabilities: {
              select: {
                serviceCategoryId: true,
                proficiency: true,
                isEnabled: true,
              },
            },
            availabilityBlocks: {
              where: { endAt: { gt: new Date() } },
              select: {
                id: true,
                type: true,
                startAt: true,
                endAt: true,
                reason: true,
              },
              orderBy: { startAt: "asc" },
              take: 10,
            },
          },
          orderBy: { fullName: "asc" },
        }),
        this.prisma.serviceCategory.findMany({
          where: { tenantId },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        }),
      ]);
    return { rules, serviceAreas, technicians, serviceCategories };
  }

  async saveRule(input: {
    tenantId: string;
    ruleId?: string;
    actorId: string;
    traceId?: string;
    dto: SaveRoutingRuleDto;
  }) {
    await this.validateRuleReferences(input.tenantId, input.dto);
    const data = {
      tenantId: input.tenantId,
      name: input.dto.name,
      status: input.dto.status,
      priority: input.dto.priority,
      serviceCategoryId: input.dto.serviceCategoryId ?? null,
      serviceCategoryTenantId: input.dto.serviceCategoryId
        ? input.tenantId
        : null,
      serviceAreaId: input.dto.serviceAreaId ?? null,
      serviceAreaTenantId: input.dto.serviceAreaId ? input.tenantId : null,
      urgency: input.dto.urgency ?? null,
      timeScope: input.dto.timeScope,
      requireAvailable: input.dto.requireAvailable,
      requireOnCall: input.dto.requireOnCall,
      escalateToOwner: input.dto.escalateToOwner,
      escalateToOnCall: input.dto.escalateToOnCall,
    };
    return this.prisma.$transaction(async (tx) => {
      const rule = input.ruleId
        ? await tx.routingRule.update({
            where: {
              id_tenantId: { id: input.ruleId, tenantId: input.tenantId },
            },
            data,
          })
        : await tx.routingRule.create({ data });
      await this.audit(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: input.ruleId ? "routing.rule_updated" : "routing.rule_created",
        entityType: "RoutingRule",
        entityId: rule.id,
        metadata: { priority: rule.priority, status: rule.status },
        traceId: input.traceId,
      });
      return rule;
    });
  }

  async saveServiceArea(input: {
    tenantId: string;
    serviceAreaId?: string;
    actorId: string;
    traceId?: string;
    dto: SaveServiceAreaDto;
  }) {
    const postalCodes = [
      ...new Set(input.dto.postalCodes.map((code) => code.trim())),
    ];
    return this.prisma.$transaction(async (tx) => {
      const data = {
        name: input.dto.name,
        type: ServiceAreaType.ZIP,
        status: input.dto.status,
        definition: { postalCodes } satisfies Prisma.InputJsonValue,
      };
      const area = input.serviceAreaId
        ? await tx.serviceArea.update({
            where: {
              id_tenantId: {
                id: input.serviceAreaId,
                tenantId: input.tenantId,
              },
            },
            data,
          })
        : await tx.serviceArea.create({
            data: { tenantId: input.tenantId, ...data },
          });
      await this.audit(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: input.serviceAreaId
          ? "routing.service_area_updated"
          : "routing.service_area_created",
        entityType: "ServiceArea",
        entityId: area.id,
        metadata: { postalCodeCount: postalCodes.length, status: area.status },
        traceId: input.traceId,
      });
      return area;
    });
  }

  async configureTechnician(input: {
    tenantId: string;
    technicianId: string;
    actorId: string;
    traceId?: string;
    dto: ConfigureTechnicianRoutingDto;
  }) {
    const technician = await this.prisma.user.findFirst({
      where: {
        id: input.technicianId,
        tenantId: input.tenantId,
        role: UserRole.TECH,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    if (!technician) throw new NotFoundException("Technician was not found.");
    const categoryIds = [
      ...new Set(input.dto.capabilities.map((item) => item.serviceCategoryId)),
    ];
    const categoryCount = await this.prisma.serviceCategory.count({
      where: { tenantId: input.tenantId, id: { in: categoryIds } },
    });
    if (categoryCount !== categoryIds.length) {
      throw new BadRequestException(
        "A service capability does not belong to this tenant.",
      );
    }
    if (input.dto.availabilityBlock) {
      const startAt = new Date(input.dto.availabilityBlock.startAt);
      const endAt = new Date(input.dto.availabilityBlock.endAt);
      if (endAt <= startAt) {
        throw new BadRequestException(
          "Availability end must be after its start.",
        );
      }
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: {
          id_tenantId: { id: input.technicianId, tenantId: input.tenantId },
        },
        data: {
          isAvailable: input.dto.isAvailable,
          isOnCall: input.dto.isOnCall,
        },
      });
      for (const capability of input.dto.capabilities) {
        await tx.userServiceCapability.upsert({
          where: {
            tenantId_userId_serviceCategoryId: {
              tenantId: input.tenantId,
              userId: input.technicianId,
              serviceCategoryId: capability.serviceCategoryId,
            },
          },
          create: {
            tenantId: input.tenantId,
            userId: input.technicianId,
            userTenantId: input.tenantId,
            serviceCategoryId: capability.serviceCategoryId,
            serviceCategoryTenantId: input.tenantId,
            proficiency: capability.proficiency,
            isEnabled: capability.isEnabled,
          },
          update: {
            proficiency: capability.proficiency,
            isEnabled: capability.isEnabled,
          },
        });
      }
      if (input.dto.availabilityBlock) {
        await tx.userAvailabilityBlock.create({
          data: {
            tenantId: input.tenantId,
            userId: input.technicianId,
            userTenantId: input.tenantId,
            type: input.dto.availabilityBlock.type,
            startAt: new Date(input.dto.availabilityBlock.startAt),
            endAt: new Date(input.dto.availabilityBlock.endAt),
            reason: input.dto.availabilityBlock.reason,
          },
        });
      }
      await this.audit(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: "routing.technician_updated",
        entityType: "User",
        entityId: input.technicianId,
        metadata: {
          isAvailable: input.dto.isAvailable,
          isOnCall: input.dto.isOnCall,
          capabilityCount: input.dto.capabilities.length,
          availabilityBlockAdded: Boolean(input.dto.availabilityBlock),
        },
        traceId: input.traceId,
      });
      return { changed: true, technicianId: input.technicianId };
    });
  }

  async evaluateAndAudit(input: {
    tenantId: string;
    jobId: string;
    actorId: string;
    traceId?: string;
  }) {
    const evaluation = await this.evaluateJob(input.tenantId, input.jobId);
    await this.prisma.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actorType: AuditActorType.USER,
        actorId: input.actorId,
        action: "routing.rule_evaluated",
        entityType: "Job",
        entityId: input.jobId,
        metadata: evaluation as unknown as Prisma.InputJsonValue,
        traceId: input.traceId,
      },
    });
    return evaluation;
  }

  async evaluateJob(
    tenantId: string,
    jobId: string,
    client: PrismaClient = this.prisma,
  ): Promise<RoutingEvaluation> {
    const job = await client.job.findFirst({
      where: { id: jobId, tenantId, deletedAt: null },
      select: {
        id: true,
        urgency: true,
        serviceCategoryId: true,
        serviceWindowStart: true,
        tenant: { select: { timezone: true } },
        propertyAddress: {
          select: { addressComponents: true, formattedAddress: true },
        },
      },
    });
    if (!job) throw new NotFoundException("Routing job was not found.");
    const at = job.serviceWindowStart ?? new Date();
    const timeScope = this.timeScope(at, job.tenant.timezone);
    const postalCode = this.postalCode(
      job.propertyAddress.addressComponents,
      job.propertyAddress.formattedAddress,
    );
    const rules = await client.routingRule.findMany({
      where: { tenantId, status: RoutingRuleStatus.ACTIVE },
      include: { serviceArea: true },
      orderBy: [{ priority: "asc" }, { id: "asc" }],
    });
    const baseMatches = rules.filter(
      (rule) =>
        (!rule.serviceCategoryId ||
          rule.serviceCategoryId === job.serviceCategoryId) &&
        (!rule.urgency || rule.urgency === job.urgency) &&
        (rule.timeScope === RoutingTimeScope.ANY ||
          rule.timeScope === timeScope),
    );
    const matched = baseMatches.find(
      (rule) =>
        !rule.serviceArea || this.areaContains(rule.serviceArea, postalCode),
    );
    const covered = baseMatches.length === 0 || Boolean(matched);
    const reasonCodes: string[] = [timeScope];
    if (baseMatches.length === 0)
      reasonCodes.push("NO_ROUTING_RULE_CONFIGURED");
    else if (!matched) reasonCodes.push("SERVICE_AREA_OUT_OF_COVERAGE");
    else {
      reasonCodes.push("ROUTING_RULE_MATCHED");
      if (matched.serviceArea) reasonCodes.push("SERVICE_AREA_MATCHED");
    }
    const shouldEscalate = job.urgency === JobUrgency.EMERGENCY;
    const escalationUsers =
      shouldEscalate && matched
        ? await client.user.findMany({
            where: {
              tenantId,
              status: UserStatus.ACTIVE,
              OR: [
                ...(matched.escalateToOwner
                  ? [{ role: { in: [UserRole.OWNER, UserRole.ADMIN] } }]
                  : []),
                ...(matched.escalateToOnCall ? [{ isOnCall: true }] : []),
              ],
            },
            select: { id: true, fullName: true, role: true, isOnCall: true },
            orderBy: [{ role: "asc" }, { fullName: "asc" }],
          })
        : [];
    const escalationPath = escalationUsers.map((user) => ({
      userId: user.id,
      fullName: user.fullName,
      role: user.role,
      reason:
        user.isOnCall && matched?.escalateToOnCall
          ? ("ON_CALL" as const)
          : ("OWNER" as const),
    }));
    if (shouldEscalate && matched?.escalateToOwner)
      reasonCodes.push("OWNER_ESCALATION");
    if (shouldEscalate && matched?.escalateToOnCall)
      reasonCodes.push("ON_CALL_ESCALATION");
    return {
      version: "routing-v1",
      jobId: job.id,
      timeScope,
      postalCode,
      covered,
      matchedRule: matched
        ? { id: matched.id, name: matched.name, priority: matched.priority }
        : null,
      requirements: {
        requireAvailable: matched?.requireAvailable ?? true,
        requireOnCall: matched?.requireOnCall ?? false,
      },
      reasonCodes,
      reasons: reasonCodes.map((code) => this.reasonLabel(code)),
      escalationPath,
    };
  }

  private async validateRuleReferences(
    tenantId: string,
    dto: SaveRoutingRuleDto,
  ) {
    const [category, area] = await Promise.all([
      dto.serviceCategoryId
        ? this.prisma.serviceCategory.findFirst({
            where: { id: dto.serviceCategoryId, tenantId },
            select: { id: true },
          })
        : Promise.resolve({ id: "all" }),
      dto.serviceAreaId
        ? this.prisma.serviceArea.findFirst({
            where: { id: dto.serviceAreaId, tenantId },
            select: { id: true },
          })
        : Promise.resolve({ id: "all" }),
    ]);
    if (!category)
      throw new BadRequestException(
        "Service category does not belong to this tenant.",
      );
    if (!area)
      throw new BadRequestException(
        "Service area does not belong to this tenant.",
      );
  }

  private timeScope(
    at: Date,
    timezone: string,
  ): "BUSINESS_HOURS" | "AFTER_HOURS" {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const weekday =
      parts.find((part) => part.type === "weekday")?.value ?? "Sun";
    const hour = Number(
      parts.find((part) => part.type === "hour")?.value ?? "0",
    );
    return !["Sat", "Sun"].includes(weekday) && hour >= 8 && hour < 18
      ? "BUSINESS_HOURS"
      : "AFTER_HOURS";
  }

  private postalCode(
    components: Prisma.JsonValue,
    formatted: string,
  ): string | null {
    if (Array.isArray(components)) {
      const item = components.find((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return false;
        const types = (value as Prisma.JsonObject).types;
        return Array.isArray(types) && types.includes("postal_code");
      });
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const record = item as Prisma.JsonObject;
        const value =
          record.long_name ??
          record.longName ??
          record.short_name ??
          record.shortName;
        if (typeof value === "string") return value.slice(0, 5);
      }
    } else if (components && typeof components === "object") {
      const record = components as Prisma.JsonObject;
      const value = record.postalCode ?? record.postal_code ?? record.zip;
      if (typeof value === "string") return value.slice(0, 5);
    }
    return formatted.match(/\b\d{5}(?:-\d{4})?\b/)?.[0].slice(0, 5) ?? null;
  }

  private areaContains(
    area: {
      status: ServiceAreaStatus;
      type: ServiceAreaType;
      definition: Prisma.JsonValue;
    },
    postalCode: string | null,
  ): boolean {
    if (
      area.status !== ServiceAreaStatus.ACTIVE ||
      area.type !== ServiceAreaType.ZIP ||
      !postalCode
    )
      return false;
    if (
      !area.definition ||
      typeof area.definition !== "object" ||
      Array.isArray(area.definition)
    )
      return false;
    const values = (area.definition as Prisma.JsonObject).postalCodes;
    return (
      Array.isArray(values) &&
      values.some((value) => String(value).slice(0, 5) === postalCode)
    );
  }

  private reasonLabel(code: string) {
    const labels: Record<string, string> = {
      BUSINESS_HOURS: "Service window is during business hours",
      AFTER_HOURS: "Service window is after hours",
      NO_ROUTING_RULE_CONFIGURED:
        "No matching tenant rule; safe default availability policy applies",
      SERVICE_AREA_OUT_OF_COVERAGE:
        "Address is outside every applicable active service area",
      ROUTING_RULE_MATCHED: "Highest-priority applicable routing rule matched",
      SERVICE_AREA_MATCHED:
        "Address postal code is inside the configured service area",
      OWNER_ESCALATION:
        "Emergency escalation includes an owner or administrator",
      ON_CALL_ESCALATION: "Emergency escalation includes on-call personnel",
    };
    return labels[code] ?? "Routing factor recorded";
  }

  private audit(
    client: Prisma.TransactionClient,
    input: {
      tenantId: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      metadata: Prisma.InputJsonValue;
      traceId?: string;
    },
  ) {
    return client.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actorType: AuditActorType.USER,
        actorId: input.actorId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: input.metadata,
        traceId: input.traceId,
      },
    });
  }
}
