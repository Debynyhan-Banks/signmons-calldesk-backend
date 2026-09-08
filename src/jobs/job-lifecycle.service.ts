import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuditActorType, JobStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  unfinishedCalendarOperations,
  noUnfinishedCalendarOperations,
  requireCalendarOperationSettled,
} from "../scheduling/calendar-operation-guard";

export interface CompleteJobRequest {
  tenantId: string;
  jobId: string;
  actorId: string;
  traceId?: string;
}

export interface CompleteJobResult {
  jobId: string;
  status: "COMPLETED";
  completedAt: string;
  changed: boolean;
}

@Injectable()
export class JobLifecycleService {
  constructor(private readonly prisma: PrismaService) {}

  async completeJob(request: CompleteJobRequest): Promise<CompleteJobResult> {
    return this.prisma.$transaction(async (transaction) => {
      const job = await transaction.job.findFirst({
        where: {
          id: request.jobId,
          tenantId: request.tenantId,
          deletedAt: null,
        },
        select: {
          id: true,
          status: true,
          completedAt: true,
          updatedAt: true,
          calendarOperations: unfinishedCalendarOperations,
        },
      });

      if (!job) {
        throw new NotFoundException("Job was not found.");
      }
      requireCalendarOperationSettled(job);

      if (job.status === JobStatus.COMPLETED) {
        if (!job.completedAt) {
          throw new ConflictException(
            "Completed job is missing its completion timestamp.",
          );
        }
        return this.toResult(job.id, job.completedAt, false);
      }

      if (!this.isCompletable(job.status)) {
        throw new ConflictException(
          "Only accepted or in-progress jobs can be completed.",
        );
      }

      const completedAt = new Date();
      const update = await transaction.job.updateMany({
        where: {
          id: job.id,
          tenantId: request.tenantId,
          deletedAt: null,
          status: job.status,
          updatedAt: job.updatedAt,
          calendarOperations: noUnfinishedCalendarOperations,
        },
        data: {
          status: JobStatus.COMPLETED,
          completedAt,
          updatedAt: new Date(
            Math.max(completedAt.getTime(), job.updatedAt.getTime() + 1),
          ),
        },
      });

      if (update.count === 0) {
        const current = await transaction.job.findFirst({
          where: {
            id: request.jobId,
            tenantId: request.tenantId,
            deletedAt: null,
          },
          select: {
            id: true,
            status: true,
            completedAt: true,
            calendarOperations: unfinishedCalendarOperations,
          },
        });
        if (current?.status === JobStatus.COMPLETED && current.completedAt) {
          requireCalendarOperationSettled(current);
          return this.toResult(current.id, current.completedAt, false);
        }
        throw new ConflictException("Job status changed before completion.");
      }

      await transaction.auditLog.create({
        data: {
          tenantId: request.tenantId,
          action: "job.completed",
          actorType: AuditActorType.USER,
          actorId: request.actorId,
          entityType: "Job",
          entityId: job.id,
          metadata: {
            previousStatus: job.status,
            completedAt: completedAt.toISOString(),
          } satisfies Prisma.InputJsonValue,
          traceId: request.traceId,
        },
      });

      return this.toResult(job.id, completedAt, true);
    });
  }

  private isCompletable(status: JobStatus): boolean {
    return status === JobStatus.ACCEPTED || status === JobStatus.IN_PROGRESS;
  }

  private toResult(
    jobId: string,
    completedAt: Date,
    changed: boolean,
  ): CompleteJobResult {
    return {
      jobId,
      status: JobStatus.COMPLETED,
      completedAt: completedAt.toISOString(),
      changed,
    };
  }
}
