import { ConflictException, NotFoundException } from "@nestjs/common";
import { AuditActorType, JobStatus } from "@prisma/client";
import { JobLifecycleService } from "./job-lifecycle.service";

describe("JobLifecycleService", () => {
  const completedAt = new Date("2026-08-30T18:00:00.000Z");

  const createHarness = () => {
    const transaction = {
      job: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
      auditLog: {
        create: jest.fn<(input: unknown) => Promise<{ id: string }>>(),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };
    const service = new JobLifecycleService(prisma as never);
    return { service, prisma, transaction };
  };

  const request = {
    tenantId: "059c4950-171c-4ff5-a963-20bf6b9d59a6",
    jobId: "8ed72154-fe35-45a2-b3b5-e5218d5026f9",
    actorId: "firebase-user-1",
    traceId: "request-1",
  };

  it.each([JobStatus.ACCEPTED, JobStatus.IN_PROGRESS])(
    "atomically completes an %s job and writes one privacy-safe audit entry",
    async (status) => {
      jest.useFakeTimers().setSystemTime(completedAt);
      const { service, prisma, transaction } = createHarness();
      transaction.job.findFirst.mockResolvedValue({
        id: request.jobId,
        status,
        completedAt: null,
      });
      transaction.job.updateMany.mockResolvedValue({ count: 1 });
      transaction.auditLog.create.mockResolvedValue({ id: "audit-1" });

      await expect(service.completeJob(request)).resolves.toEqual({
        jobId: request.jobId,
        status: JobStatus.COMPLETED,
        completedAt: completedAt.toISOString(),
        changed: true,
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(transaction.job.findFirst).toHaveBeenCalledWith({
        where: {
          id: request.jobId,
          tenantId: request.tenantId,
          deletedAt: null,
        },
        select: { id: true, status: true, completedAt: true },
      });
      expect(transaction.job.updateMany).toHaveBeenCalledWith({
        where: {
          id: request.jobId,
          tenantId: request.tenantId,
          deletedAt: null,
          status,
        },
        data: { status: JobStatus.COMPLETED, completedAt },
      });
      expect(transaction.auditLog.create).toHaveBeenCalledWith({
        data: {
          tenantId: request.tenantId,
          action: "job.completed",
          actorType: AuditActorType.USER,
          actorId: request.actorId,
          entityType: "Job",
          entityId: request.jobId,
          metadata: {
            previousStatus: status,
            completedAt: completedAt.toISOString(),
          },
          traceId: request.traceId,
        },
      });
      jest.useRealTimers();
    },
  );

  it("returns an idempotent replay without another mutation or audit", async () => {
    const { service, transaction } = createHarness();
    transaction.job.findFirst.mockResolvedValue({
      id: request.jobId,
      status: JobStatus.COMPLETED,
      completedAt,
    });

    await expect(service.completeJob(request)).resolves.toEqual({
      jobId: request.jobId,
      status: JobStatus.COMPLETED,
      completedAt: completedAt.toISOString(),
      changed: false,
    });
    expect(transaction.job.updateMany).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    JobStatus.CREATED,
    JobStatus.OFFERED,
    JobStatus.DECLINED,
    JobStatus.EXPIRED,
    JobStatus.CANCELLED,
  ])("rejects the %s transition", async (status) => {
    const { service, transaction } = createHarness();
    transaction.job.findFirst.mockResolvedValue({
      id: request.jobId,
      status,
      completedAt: null,
    });

    await expect(service.completeJob(request)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(transaction.job.updateMany).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it("uses the same not-found boundary for missing and cross-tenant jobs", async () => {
    const { service, transaction } = createHarness();
    transaction.job.findFirst.mockResolvedValue(null);

    await expect(service.completeJob(request)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(transaction.job.updateMany).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it("returns a replay when a concurrent request completed the job", async () => {
    const { service, transaction } = createHarness();
    transaction.job.findFirst
      .mockResolvedValueOnce({
        id: request.jobId,
        status: JobStatus.ACCEPTED,
        completedAt: null,
      })
      .mockResolvedValueOnce({
        id: request.jobId,
        status: JobStatus.COMPLETED,
        completedAt,
      });
    transaction.job.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.completeJob(request)).resolves.toEqual({
      jobId: request.jobId,
      status: JobStatus.COMPLETED,
      completedAt: completedAt.toISOString(),
      changed: false,
    });
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });
});
