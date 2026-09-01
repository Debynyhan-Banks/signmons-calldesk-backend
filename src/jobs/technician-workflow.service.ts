import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  AuditActorType,
  JobStatus,
  Prisma,
  TechnicianJobStatus,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TechnicianJobAction } from "./dto/update-technician-job.dto";
import {
  TechnicianLinkService,
  VerifiedTechnicianLink,
} from "./technician-link.service";

const OPEN_JOB_STATUSES = [
  JobStatus.CREATED,
  JobStatus.OFFERED,
  JobStatus.ACCEPTED,
  JobStatus.IN_PROGRESS,
];

const JOB_INCLUDE = {
  customer: {
    select: { fullName: true, phone: true, email: true },
  },
  propertyAddress: {
    select: { formattedAddress: true, accessNotes: true },
  },
  serviceCategory: {
    select: { name: true },
  },
} satisfies Prisma.JobInclude;

type TechnicianJob = Prisma.JobGetPayload<{ include: typeof JOB_INCLUDE }>;

const TRANSITIONS: Record<TechnicianJobStatus, TechnicianJobAction[]> = {
  ASSIGNED: ["accept", "decline", "cannot_take"],
  ACCEPTED: ["on_my_way", "in_progress", "decline", "cannot_take"],
  EN_ROUTE: ["in_progress", "cannot_take"],
  IN_PROGRESS: ["complete"],
  COMPLETED: [],
};

@Injectable()
export class TechnicianWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly links: TechnicianLinkService,
  ) {}

  async list(rawToken: string | undefined) {
    const access = this.links.verify(rawToken);
    const technician = await this.activeTechnician(access);
    const jobs = await this.prisma.job.findMany({
      where: {
        tenantId: access.tenantId,
        assignedUserId: access.technicianId,
        assignedUserTenantId: access.tenantId,
        deletedAt: null,
        OR: [
          { status: { in: OPEN_JOB_STATUSES } },
          {
            status: JobStatus.COMPLETED,
            completedAt: {
              gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
            },
          },
        ],
      },
      include: JOB_INCLUDE,
      orderBy: [{ serviceWindowStart: "asc" }, { createdAt: "asc" }],
      take: 200,
    });
    const todayKey = this.dateKey(new Date(), technician.timezone);
    const grouped = {
      today: [] as ReturnType<typeof this.toSummary>[],
      upcoming: [] as ReturnType<typeof this.toSummary>[],
      completed: [] as ReturnType<typeof this.toSummary>[],
    };
    for (const job of jobs) {
      const summary = this.toSummary(job);
      if (job.status === JobStatus.COMPLETED) grouped.completed.push(summary);
      else if (
        job.serviceWindowStart &&
        this.dateKey(job.serviceWindowStart, technician.timezone) === todayKey
      ) {
        grouped.today.push(summary);
      } else grouped.upcoming.push(summary);
    }
    grouped.completed.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );

    return {
      technician: {
        id: technician.id,
        fullName: technician.fullName,
      },
      timezone: technician.timezone,
      linkExpiresAt: access.expiresAt.toISOString(),
      groups: grouped,
    };
  }

  async get(rawToken: string | undefined, jobId: string) {
    const access = this.links.verify(rawToken);
    await this.activeTechnician(access);
    const job = await this.findAssignedJob(access, jobId);
    return this.toDetail(job);
  }

  async update(input: {
    rawToken: string | undefined;
    jobId: string;
    action: TechnicianJobAction;
    expectedUpdatedAt: string;
    note?: string;
    traceId?: string;
  }) {
    const access = this.links.verify(input.rawToken);
    await this.activeTechnician(access);
    const expectedUpdatedAt = new Date(input.expectedUpdatedAt);

    return this.prisma.$transaction(async (transaction) => {
      const job = await transaction.job.findFirst({
        where: {
          id: input.jobId,
          tenantId: access.tenantId,
          assignedUserId: access.technicianId,
          assignedUserTenantId: access.tenantId,
          deletedAt: null,
        },
        include: JOB_INCLUDE,
      });
      if (!job) throw new NotFoundException("Assigned job was not found.");
      if (job.status === JobStatus.CANCELLED) {
        throw new ConflictException("Cancelled jobs cannot be updated.");
      }

      const current = this.currentTechnicianStatus(job);
      const target = this.targetStatus(input.action);
      if (target && current === target) {
        return { ...this.toDetail(job), changed: false };
      }
      if (!TRANSITIONS[current].includes(input.action)) {
        throw new ConflictException(
          `The ${input.action.replace(/_/g, " ")} action is not available from ${current.toLowerCase().replace(/_/g, " ")}.`,
        );
      }

      const changedAt = new Date();
      const releaseAssignment =
        input.action === "decline" || input.action === "cannot_take";
      const updateData: Prisma.JobUncheckedUpdateManyInput = releaseAssignment
        ? {
            assignedUserId: null,
            assignedUserTenantId: null,
            technicianStatus: null,
            technicianStatusUpdatedAt: changedAt,
          }
        : {
            technicianStatus: target,
            technicianStatusUpdatedAt: changedAt,
          };

      if (input.action === "accept" || input.action === "on_my_way") {
        if (
          job.status === JobStatus.CREATED ||
          job.status === JobStatus.OFFERED ||
          job.status === JobStatus.DECLINED ||
          job.status === JobStatus.EXPIRED
        ) {
          updateData.status = JobStatus.ACCEPTED;
        }
        if (!job.acceptedAt) updateData.acceptedAt = changedAt;
      }
      if (input.action === "in_progress") {
        updateData.status = JobStatus.IN_PROGRESS;
      }
      if (input.action === "complete") {
        updateData.status = JobStatus.COMPLETED;
        updateData.completedAt = changedAt;
      }

      const updated = await transaction.job.updateMany({
        where: {
          id: job.id,
          tenantId: access.tenantId,
          assignedUserId: access.technicianId,
          assignedUserTenantId: access.tenantId,
          updatedAt: expectedUpdatedAt,
          deletedAt: null,
        },
        data: updateData,
      });
      if (updated.count !== 1) {
        throw new ConflictException(
          "This job changed after it was loaded. Refresh before trying again.",
        );
      }

      await transaction.auditLog.create({
        data: {
          tenantId: access.tenantId,
          action: this.auditAction(input.action),
          actorType: AuditActorType.USER,
          actorId: access.technicianId,
          entityType: "Job",
          entityId: job.id,
          metadata: {
            previousTechnicianStatus: current,
            technicianStatus: target ?? null,
            assignmentReleased: releaseAssignment,
            note: input.note ?? null,
          } satisfies Prisma.InputJsonValue,
          traceId: input.traceId,
        },
      });

      if (releaseAssignment) {
        return {
          jobId: job.id,
          action: input.action,
          changed: true,
          assignmentReleased: true,
          updatedAt: changedAt.toISOString(),
        };
      }

      const changed = await transaction.job.findFirst({
        where: {
          id: job.id,
          tenantId: access.tenantId,
          assignedUserId: access.technicianId,
        },
        include: JOB_INCLUDE,
      });
      if (!changed) {
        throw new ConflictException("Updated job could not be reloaded.");
      }
      return { ...this.toDetail(changed), changed: true };
    });
  }

  private async activeTechnician(access: VerifiedTechnicianLink) {
    const technician = await this.prisma.user.findFirst({
      where: {
        id: access.technicianId,
        tenantId: access.tenantId,
        role: UserRole.TECH,
        status: UserStatus.ACTIVE,
      },
      select: {
        id: true,
        fullName: true,
        tenant: { select: { timezone: true } },
      },
    });
    if (!technician) {
      throw new UnauthorizedException("Technician access is no longer active.");
    }
    return {
      id: technician.id,
      fullName: technician.fullName,
      timezone: technician.tenant.timezone,
    };
  }

  private async findAssignedJob(
    access: VerifiedTechnicianLink,
    jobId: string,
  ): Promise<TechnicianJob> {
    const job = await this.prisma.job.findFirst({
      where: {
        id: jobId,
        tenantId: access.tenantId,
        assignedUserId: access.technicianId,
        assignedUserTenantId: access.tenantId,
        deletedAt: null,
      },
      include: JOB_INCLUDE,
    });
    if (!job) throw new NotFoundException("Assigned job was not found.");
    return job;
  }

  private toSummary(job: TechnicianJob) {
    const technicianStatus = this.currentTechnicianStatus(job);
    return {
      jobId: job.id,
      reference: job.id.replace(/-/g, "").slice(0, 8).toUpperCase(),
      serviceCategory: job.serviceCategory.name,
      serviceAddress: job.propertyAddress.formattedAddress,
      serviceWindowStart: job.serviceWindowStart?.toISOString() ?? null,
      serviceWindowEnd: job.serviceWindowEnd?.toISOString() ?? null,
      urgency: job.urgency,
      technicianStatus,
      availableActions: TRANSITIONS[technicianStatus],
      updatedAt: job.updatedAt.toISOString(),
    };
  }

  private toDetail(job: TechnicianJob) {
    return {
      ...this.toSummary(job),
      customer: {
        fullName: job.customer.fullName,
        phone: job.customer.phone,
        email: job.customer.email,
      },
      accessNotes: job.propertyAddress.accessNotes,
      issueSummary: job.description,
      preferredTimeText: job.preferredTimeText,
      jobStatus: job.status,
    };
  }

  private currentTechnicianStatus(job: {
    status: JobStatus;
    technicianStatus: TechnicianJobStatus | null;
  }): TechnicianJobStatus {
    if (job.technicianStatus) return job.technicianStatus;
    if (job.status === JobStatus.COMPLETED)
      return TechnicianJobStatus.COMPLETED;
    if (job.status === JobStatus.IN_PROGRESS)
      return TechnicianJobStatus.IN_PROGRESS;
    return TechnicianJobStatus.ASSIGNED;
  }

  private targetStatus(
    action: TechnicianJobAction,
  ): TechnicianJobStatus | null {
    const targets: Record<TechnicianJobAction, TechnicianJobStatus | null> = {
      accept: TechnicianJobStatus.ACCEPTED,
      decline: null,
      on_my_way: TechnicianJobStatus.EN_ROUTE,
      in_progress: TechnicianJobStatus.IN_PROGRESS,
      complete: TechnicianJobStatus.COMPLETED,
      cannot_take: null,
    };
    return targets[action];
  }

  private auditAction(action: TechnicianJobAction): string {
    const actions: Record<TechnicianJobAction, string> = {
      accept: "job.technician_accepted",
      decline: "job.technician_declined",
      on_my_way: "job.technician_en_route",
      in_progress: "job.technician_started",
      complete: "job.technician_completed",
      cannot_take: "job.technician_unavailable",
    };
    return actions[action];
  }

  private dateKey(value: Date, timezone: string): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  }
}
