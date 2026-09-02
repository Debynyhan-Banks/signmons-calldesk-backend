import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  AuditActorType,
  AvailabilityBlockType,
  JobStatus,
  JobUrgency,
  Prisma,
  ProficiencyLevel,
  TechnicianJobStatus,
  UserStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RoutingEvaluation, RoutingService } from "./routing.service";

export type DispatchQueue =
  | "NEW_REQUEST"
  | "READY_TO_ASSIGN"
  | "ASSIGNED"
  | "ESCALATED";

type DispatchJob = Prisma.JobGetPayload<{
  include: {
    tenant: {
      select: {
        timezone: true;
      };
    };
    serviceCategory: true;
    assignedUser: {
      select: {
        id: true;
        fullName: true;
        role: true;
        isAvailable: true;
      };
    };
  };
}>;

type Candidate = {
  userId: string;
  fullName: string;
  role: string;
  available: boolean;
  onCall: boolean;
  proficiency: ProficiencyLevel | null;
  activeAssignments: number;
  eligible: boolean;
  reasonCodes: string[];
  score: number;
};

const ACTIVE_JOB_STATUSES = [
  JobStatus.CREATED,
  JobStatus.OFFERED,
  JobStatus.ACCEPTED,
  JobStatus.IN_PROGRESS,
];
const ASSIGNMENT_ACTIONS = [
  "job.assigned",
  "job.reassigned",
  "job.assignment_cancelled",
  "job.technician_accepted",
  "job.technician_declined",
  "job.technician_en_route",
  "job.technician_started",
  "job.technician_completed",
  "job.technician_unavailable",
];
const CUSTOMER_BOOKING_ACTIONS = [
  "appointment.customer_confirmed",
  "appointment.customer_reschedule_requested",
  "appointment.customer_rescheduled",
];
const OVERRIDE_REASON_MIN_LENGTH = 10;

@Injectable()
export class DispatchBoardService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly routingService?: RoutingService,
  ) {}

  async list(tenantId: string) {
    const jobs = await this.prisma.job.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: { in: ACTIVE_JOB_STATUSES },
      },
      include: {
        tenant: { select: { timezone: true } },
        serviceCategory: true,
        assignedUser: {
          select: {
            id: true,
            fullName: true,
            role: true,
            isAvailable: true,
          },
        },
      },
      orderBy: [{ urgency: "desc" }, { createdAt: "asc" }],
      take: 200,
    });
    const escalatedIds = await this.escalatedJobIds(
      tenantId,
      jobs.map((job) => job.id),
    );
    return jobs.map((job) => this.toSummary(job, escalatedIds.has(job.id)));
  }

  async get(tenantId: string, jobId: string) {
    const job = await this.findJob(tenantId, jobId);
    const [escalatedIds, routing, history, customerBooking] = await Promise.all(
      [
        this.escalatedJobIds(tenantId, [jobId]),
        this.routingService?.evaluateJob(tenantId, jobId) ??
          Promise.resolve(this.defaultRouting(jobId)),
        this.assignmentHistory(tenantId, jobId),
        this.customerBookingActivity(tenantId, jobId),
      ],
    );
    const candidates = await this.candidates(
      tenantId,
      job,
      this.prisma,
      routing,
    );
    const recommendation = this.recommend(candidates);
    return {
      ...this.toSummary(job, escalatedIds.has(job.id)),
      recommendation: recommendation
        ? {
            version: "dispatch-v2",
            technicianId: recommendation.userId,
            technicianName: recommendation.fullName,
            reasonCodes: recommendation.reasonCodes.filter(
              (code) =>
                !code.startsWith("MISSING_") && code !== "SCHEDULE_CONFLICT",
            ),
            reasons: recommendation.reasonCodes
              .filter(
                (code) =>
                  !code.startsWith("MISSING_") && code !== "SCHEDULE_CONFLICT",
              )
              .map((code) => this.reasonLabel(code)),
          }
        : null,
      candidates: candidates.map((candidate) => ({
        userId: candidate.userId,
        fullName: candidate.fullName,
        role: candidate.role,
        available: candidate.available,
        onCall: candidate.onCall,
        proficiency: candidate.proficiency,
        activeAssignments: candidate.activeAssignments,
        eligible: candidate.eligible,
        reasonCodes: candidate.reasonCodes,
        reasons: candidate.reasonCodes.map((code) => this.reasonLabel(code)),
      })),
      assignmentHistory: history,
      customerBooking,
      routing,
    };
  }

  async assign(input: {
    tenantId: string;
    jobId: string;
    technicianId: string;
    expectedUpdatedAt: string;
    actorId: string;
    reason?: string;
    traceId?: string;
  }) {
    const expectedUpdatedAt = new Date(input.expectedUpdatedAt);
    return this.prisma.$transaction(async (transaction) => {
      const job = await transaction.job.findFirst({
        where: { id: input.jobId, tenantId: input.tenantId, deletedAt: null },
        include: {
          tenant: { select: { timezone: true } },
          serviceCategory: true,
          assignedUser: {
            select: {
              id: true,
              fullName: true,
              role: true,
              isAvailable: true,
            },
          },
        },
      });
      if (!job) throw new NotFoundException("Dispatch job was not found.");
      if (
        job.status === JobStatus.COMPLETED ||
        job.status === JobStatus.CANCELLED
      ) {
        throw new BadRequestException("Closed jobs cannot be assigned.");
      }
      if (job.assignedUserId === input.technicianId) {
        return {
          changed: false,
          jobId: job.id,
          assignedTechnician: job.assignedUser,
          updatedAt: job.updatedAt.toISOString(),
        };
      }

      const routing = this.routingService
        ? await this.routingService.evaluateJob(
            input.tenantId,
            job.id,
            transaction,
          )
        : this.defaultRouting(job.id);
      const candidates = await this.candidates(
        input.tenantId,
        job,
        transaction,
        routing,
      );
      const selected = candidates.find(
        (candidate) => candidate.userId === input.technicianId,
      );
      if (!selected) {
        throw new BadRequestException(
          "The selected technician is not an active dispatch candidate for this tenant.",
        );
      }
      const recommendation = this.recommend(candidates);
      const isReassignment = Boolean(job.assignedUserId);
      const isOverride =
        !selected.eligible || recommendation?.userId !== selected.userId;
      const reason = input.reason?.replace(/\s+/g, " ").trim();
      if (
        (isReassignment || isOverride) &&
        (!reason || reason.length < OVERRIDE_REASON_MIN_LENGTH)
      ) {
        throw new BadRequestException(
          "A reason of at least 10 characters is required for reassignment or recommendation override.",
        );
      }

      const update = await transaction.job.updateMany({
        where: {
          id: job.id,
          tenantId: input.tenantId,
          updatedAt: expectedUpdatedAt,
          deletedAt: null,
        },
        data: {
          assignedUserId: selected.userId,
          assignedUserTenantId: input.tenantId,
          technicianStatus: TechnicianJobStatus.ASSIGNED,
          technicianStatusUpdatedAt: new Date(),
        },
      });
      if (update.count !== 1) {
        throw new ConflictException(
          "This job changed after it was loaded. Refresh before assigning.",
        );
      }

      const action = isReassignment ? "job.reassigned" : "job.assigned";
      await transaction.auditLog.create({
        data: {
          tenantId: input.tenantId,
          action,
          actorType: AuditActorType.USER,
          actorId: input.actorId,
          entityType: "Job",
          entityId: job.id,
          metadata: {
            previousTechnicianId: job.assignedUserId,
            technicianId: selected.userId,
            recommendationVersion: "dispatch-v2",
            recommendedTechnicianId: recommendation?.userId ?? null,
            recommendationReasonCodes: recommendation?.reasonCodes ?? [],
            routing: routing as unknown as Prisma.InputJsonValue,
            override: isOverride,
            reason: reason ?? null,
          } satisfies Prisma.InputJsonValue,
          traceId: input.traceId,
        },
      });
      const changed = await transaction.job.findFirst({
        where: { id: job.id, tenantId: input.tenantId },
        select: {
          updatedAt: true,
          assignedUser: { select: { id: true, fullName: true, role: true } },
        },
      });
      return {
        changed: true,
        jobId: job.id,
        assignedTechnician: changed?.assignedUser ?? null,
        updatedAt: changed?.updatedAt.toISOString(),
      };
    });
  }

  async cancelAssignment(input: {
    tenantId: string;
    jobId: string;
    expectedUpdatedAt: string;
    actorId: string;
    reason: string;
    traceId?: string;
  }) {
    const expectedUpdatedAt = new Date(input.expectedUpdatedAt);
    return this.prisma.$transaction(async (transaction) => {
      const job = await transaction.job.findFirst({
        where: { id: input.jobId, tenantId: input.tenantId, deletedAt: null },
        select: { id: true, assignedUserId: true, updatedAt: true },
      });
      if (!job) throw new NotFoundException("Dispatch job was not found.");
      if (!job.assignedUserId) {
        return {
          changed: false,
          jobId: job.id,
          assignedTechnician: null,
          updatedAt: job.updatedAt.toISOString(),
        };
      }
      const update = await transaction.job.updateMany({
        where: {
          id: job.id,
          tenantId: input.tenantId,
          updatedAt: expectedUpdatedAt,
          deletedAt: null,
        },
        data: {
          assignedUserId: null,
          assignedUserTenantId: null,
          technicianStatus: null,
          technicianStatusUpdatedAt: new Date(),
        },
      });
      if (update.count !== 1) {
        throw new ConflictException(
          "This job changed after it was loaded. Refresh before cancelling the assignment.",
        );
      }
      await transaction.auditLog.create({
        data: {
          tenantId: input.tenantId,
          action: "job.assignment_cancelled",
          actorType: AuditActorType.USER,
          actorId: input.actorId,
          entityType: "Job",
          entityId: job.id,
          metadata: {
            previousTechnicianId: job.assignedUserId,
            reason: input.reason,
          } satisfies Prisma.InputJsonValue,
          traceId: input.traceId,
        },
      });
      const changed = await transaction.job.findFirst({
        where: { id: job.id, tenantId: input.tenantId },
        select: { updatedAt: true },
      });
      return {
        changed: true,
        jobId: job.id,
        assignedTechnician: null,
        updatedAt: changed?.updatedAt.toISOString(),
      };
    });
  }

  private async findJob(tenantId: string, jobId: string): Promise<DispatchJob> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, tenantId, deletedAt: null },
      include: {
        tenant: { select: { timezone: true } },
        serviceCategory: true,
        assignedUser: {
          select: {
            id: true,
            fullName: true,
            role: true,
            isAvailable: true,
          },
        },
      },
    });
    if (!job) throw new NotFoundException("Dispatch job was not found.");
    return job;
  }

  private async escalatedJobIds(tenantId: string, jobIds: string[]) {
    if (!jobIds.length) return new Set<string>();
    const audits = await this.prisma.auditLog.findMany({
      where: {
        tenantId,
        action: "job.urgency_escalated",
        entityType: "Job",
        entityId: { in: jobIds },
      },
      select: { entityId: true },
      distinct: ["entityId"],
    });
    return new Set(audits.map((audit) => audit.entityId));
  }

  private async candidates(
    tenantId: string,
    job: DispatchJob,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
    routing: RoutingEvaluation = this.defaultRouting(job.id),
  ): Promise<Candidate[]> {
    const users = await client.user.findMany({
      where: {
        tenantId,
        status: UserStatus.ACTIVE,
        OR: [
          { role: "TECH" },
          {
            serviceCapabilities: {
              some: {
                serviceCategoryId: job.serviceCategoryId,
                isEnabled: true,
              },
            },
          },
        ],
      },
      include: {
        serviceCapabilities: {
          where: {
            serviceCategoryId: job.serviceCategoryId,
            isEnabled: true,
          },
          select: { proficiency: true },
        },
        availabilityBlocks: {
          where:
            job.serviceWindowStart && job.serviceWindowEnd
              ? {
                  startAt: { lt: job.serviceWindowEnd },
                  endAt: { gt: job.serviceWindowStart },
                }
              : {
                  startAt: { lte: new Date() },
                  endAt: { gt: new Date() },
                },
          select: { type: true, startAt: true, endAt: true },
        },
        _count: {
          select: {
            jobs: {
              where: {
                deletedAt: null,
                status: { in: ACTIVE_JOB_STATUSES },
              },
            },
          },
        },
      },
      orderBy: [{ fullName: "asc" }, { id: "asc" }],
    });

    return users
      .map((user) => {
        const capability = user.serviceCapabilities[0];
        const unavailable = user.availabilityBlocks.some(
          (block) => block.type === AvailabilityBlockType.UNAVAILABLE,
        );
        const availableOverride = user.availabilityBlocks.some(
          (block) => block.type === AvailabilityBlockType.AVAILABLE_OVERRIDE,
        );
        const available =
          (user.isAvailable || availableOverride) && !unavailable;
        const reasonCodes: string[] = [];
        if (capability) reasonCodes.push("SERVICE_MATCH");
        else reasonCodes.push("MISSING_SERVICE_CAPABILITY");
        if (capability?.proficiency === ProficiencyLevel.EXPERT) {
          reasonCodes.push("EXPERT_MATCH");
        }
        if (available) reasonCodes.push("AVAILABLE");
        else reasonCodes.push("MARKED_UNAVAILABLE");
        if (user.isOnCall) reasonCodes.push("ON_CALL");
        else if (routing.requirements.requireOnCall)
          reasonCodes.push("NOT_ON_CALL");
        if (routing.covered) reasonCodes.push("SERVICE_AREA_ALLOWED");
        else reasonCodes.push("SERVICE_AREA_BLOCKED");
        if (!unavailable) reasonCodes.push("NO_SCHEDULE_CONFLICT");
        else reasonCodes.push("SCHEDULE_CONFLICT");
        if (user._count.jobs <= 2) reasonCodes.push("LOW_ACTIVE_WORKLOAD");
        const proficiencyScore =
          capability?.proficiency === ProficiencyLevel.EXPERT
            ? 30
            : capability?.proficiency === ProficiencyLevel.STANDARD
              ? 20
              : capability
                ? 10
                : 0;
        const urgencyBonus =
          job.urgency !== JobUrgency.STANDARD &&
          capability?.proficiency === ProficiencyLevel.EXPERT
            ? 10
            : 0;
        return {
          userId: user.id,
          fullName: user.fullName,
          role: user.role,
          available,
          onCall: user.isOnCall,
          proficiency: capability?.proficiency ?? null,
          activeAssignments: user._count.jobs,
          eligible: Boolean(
            capability &&
              routing.covered &&
              (!routing.requirements.requireAvailable ||
                (available && !unavailable)) &&
              (!routing.requirements.requireOnCall || user.isOnCall),
          ),
          reasonCodes,
          score:
            proficiencyScore +
            (available ? 25 : 0) +
            (!unavailable ? 20 : 0) +
            Math.max(0, 20 - user._count.jobs * 4) +
            urgencyBonus,
        };
      })
      .sort(
        (left, right) =>
          Number(right.eligible) - Number(left.eligible) ||
          right.score - left.score ||
          left.fullName.localeCompare(right.fullName) ||
          left.userId.localeCompare(right.userId),
      );
  }

  private recommend(candidates: Candidate[]) {
    return candidates.find((candidate) => candidate.eligible) ?? null;
  }

  private toSummary(job: DispatchJob, escalated: boolean) {
    return {
      jobId: job.id,
      reference: job.id.replace(/-/g, "").slice(0, 8).toUpperCase(),
      queue: this.queue(job, escalated),
      serviceCategory: job.serviceCategory.name,
      urgency: job.urgency,
      status: job.status,
      technicianStatus:
        job.technicianStatus ??
        (job.assignedUserId ? TechnicianJobStatus.ASSIGNED : null),
      serviceWindowStart: job.serviceWindowStart?.toISOString() ?? null,
      serviceWindowEnd: job.serviceWindowEnd?.toISOString() ?? null,
      timezone: job.tenant.timezone,
      assignedTechnician: job.assignedUser
        ? {
            id: job.assignedUser.id,
            fullName: job.assignedUser.fullName,
            role: job.assignedUser.role,
          }
        : null,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }

  private queue(job: DispatchJob, escalated: boolean): DispatchQueue {
    if (job.assignedUserId) return "ASSIGNED";
    if (escalated) return "ESCALATED";
    if (
      job.serviceWindowStart ||
      job.status === JobStatus.OFFERED ||
      job.status === JobStatus.ACCEPTED ||
      job.status === JobStatus.IN_PROGRESS
    ) {
      return "READY_TO_ASSIGN";
    }
    return "NEW_REQUEST";
  }

  private async assignmentHistory(tenantId: string, jobId: string) {
    const audits = await this.prisma.auditLog.findMany({
      where: {
        tenantId,
        entityType: "Job",
        entityId: jobId,
        action: { in: ASSIGNMENT_ACTIONS },
      },
      select: {
        id: true,
        action: true,
        actorId: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return audits.map((audit) => {
      const metadata = this.record(audit.metadata) ?? {};
      return {
        id: audit.id,
        action: audit.action,
        actorId: audit.actorId,
        technicianId:
          typeof metadata.technicianId === "string"
            ? metadata.technicianId
            : null,
        previousTechnicianId:
          typeof metadata.previousTechnicianId === "string"
            ? metadata.previousTechnicianId
            : null,
        override: metadata.override === true,
        reason: typeof metadata.reason === "string" ? metadata.reason : null,
        note: typeof metadata.note === "string" ? metadata.note : null,
        createdAt: audit.createdAt.toISOString(),
      };
    });
  }

  private async customerBookingActivity(tenantId: string, jobId: string) {
    const audits = await this.prisma.auditLog.findMany({
      where: {
        tenantId,
        entityType: "Job",
        entityId: jobId,
        action: { in: CUSTOMER_BOOKING_ACTIONS },
      },
      select: {
        id: true,
        action: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const events = audits.map((audit) => {
      const metadata = this.record(audit.metadata) ?? {};
      return {
        id: audit.id,
        action: audit.action,
        label: this.customerBookingLabel(audit.action),
        note: typeof metadata.note === "string" ? metadata.note : null,
        createdAt: audit.createdAt.toISOString(),
      };
    });
    const action = events[0]?.action;
    return {
      state:
        action === "appointment.customer_reschedule_requested"
          ? ("RESCHEDULE_REQUESTED" as const)
          : action === "appointment.customer_confirmed" ||
              action === "appointment.customer_rescheduled"
            ? ("CONFIRMED" as const)
            : ("AWAITING_RESPONSE" as const),
      label: action
        ? this.customerBookingLabel(action)
        : "Waiting for customer confirmation",
      updatedAt: events[0]?.createdAt ?? null,
      events,
    };
  }

  private customerBookingLabel(action: string): string {
    if (action === "appointment.customer_confirmed") {
      return "Customer confirmed the appointment window";
    }
    if (action === "appointment.customer_reschedule_requested") {
      return "Customer requested a different appointment time";
    }
    if (action === "appointment.customer_rescheduled") {
      return "Customer selected a new confirmed appointment window";
    }
    return "Customer booking update";
  }

  private reasonLabel(code: string): string {
    const labels: Record<string, string> = {
      SERVICE_MATCH: "Enabled for this service category",
      EXPERT_MATCH: "Expert proficiency for this service",
      AVAILABLE: "Marked available",
      NO_SCHEDULE_CONFLICT: "No conflicting availability block",
      LOW_ACTIVE_WORKLOAD: "Lower active assignment count",
      MISSING_SERVICE_CAPABILITY: "No enabled capability for this service",
      MARKED_UNAVAILABLE: "Currently marked unavailable",
      SCHEDULE_CONFLICT: "Availability block overlaps the service window",
      ON_CALL: "Technician is on call",
      NOT_ON_CALL: "Routing rule requires an on-call technician",
      SERVICE_AREA_ALLOWED: "Job is inside the applicable service area",
      SERVICE_AREA_BLOCKED: "Job is outside the applicable service area",
    };
    return labels[code] ?? "Operational factor recorded";
  }

  private defaultRouting(jobId: string): RoutingEvaluation {
    return {
      version: "routing-v1",
      jobId,
      timeScope: "BUSINESS_HOURS",
      postalCode: null,
      covered: true,
      matchedRule: null,
      requirements: { requireAvailable: true, requireOnCall: false },
      reasonCodes: ["NO_ROUTING_RULE_CONFIGURED"],
      reasons: [
        "No matching tenant rule; safe default availability policy applies",
      ],
      escalationPath: [],
    };
  }

  private record(
    value: Prisma.JsonValue | undefined,
  ): Prisma.JsonObject | null {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    return value;
  }
}
