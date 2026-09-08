import { ConflictException, Injectable } from "@nestjs/common";
import { AuditActorType, Job, JobStatus } from "@prisma/client";
import { SmsEnqueueIntentService } from "../communications/sms-enqueue-intent.service";
import { LoggingService } from "../logging/logging.service";
import { PrismaService } from "../prisma/prisma.service";

// Calendar deletion is outside these local transactions. No intent is recorded
// until the caller has received its acknowledgment.
@Injectable()
export class AppointmentCancellationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly intents: SmsEnqueueIntentService,
    private readonly logging: LoggingService,
  ) {}

  claim(job: Job, preferredTimeText: string) {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.job.updateMany({
        where: {
          id: job.id,
          tenantId: job.tenantId,
          deletedAt: null,
          status: JobStatus.ACCEPTED,
          updatedAt: job.updatedAt,
          calendarEventId: job.calendarEventId,
          serviceWindowStart: job.serviceWindowStart,
          serviceWindowEnd: job.serviceWindowEnd,
        },
        data: {
          status: JobStatus.CANCELLED,
          calendarEventId: null,
          serviceWindowStart: null,
          serviceWindowEnd: null,
          preferredTimeText,
        },
      });
      if (changed.count !== 1)
        throw new ConflictException("Appointment changed before cancellation.");
      return tx.job.findUniqueOrThrow({
        where: { id_tenantId: { id: job.id, tenantId: job.tenantId } },
      });
    });
  }

  // The prior calendar-error compensation is retained, but cannot overwrite a
  // newer job version. Unknown external outcomes still need office reconciliation.
  restore(claim: Job, original: Job) {
    return this.prisma.job.updateMany({
      where: {
        id: claim.id,
        tenantId: claim.tenantId,
        deletedAt: null,
        status: JobStatus.CANCELLED,
        calendarEventId: null,
        updatedAt: claim.updatedAt,
      },
      data: {
        status: JobStatus.ACCEPTED,
        calendarEventId: original.calendarEventId,
        serviceWindowStart: original.serviceWindowStart,
        serviceWindowEnd: original.serviceWindowEnd,
        preferredTimeText: original.preferredTimeText,
      },
    });
  }

  async assertFinalized(job: Job) {
    const proof = await this.prisma.auditLog.findFirst({
      where: {
        tenantId: job.tenantId,
        entityType: "Job",
        entityId: job.id,
        action: "appointment.customer_cancelled",
        actorType: AuditActorType.CUSTOMER,
      },
      select: { id: true },
    });
    if (!proof)
      throw new ConflictException(
        "Cancellation needs confirmation by the office. Please contact the office before trying again.",
      );
  }

  async finalize(claim: Job) {
    const intent = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.job.updateMany({
        where: {
          id: claim.id,
          tenantId: claim.tenantId,
          deletedAt: null,
          status: JobStatus.CANCELLED,
          calendarEventId: null,
          serviceWindowStart: null,
          serviceWindowEnd: null,
          updatedAt: claim.updatedAt,
        },
        // Advance even when claim/finalization share one clock millisecond.
        data: {
          status: JobStatus.CANCELLED,
          updatedAt: new Date(
            Math.max(Date.now(), claim.updatedAt.getTime() + 1),
          ),
        },
      });
      if (changed.count !== 1)
        throw new ConflictException(
          "Cancellation changed before finalization.",
        );
      const intent = await this.intents.recordCancellation(tx, {
        tenantId: claim.tenantId,
        jobId: claim.id,
      });
      await tx.auditLog.create({
        data: {
          tenantId: claim.tenantId,
          action: "appointment.customer_cancelled",
          actorType: AuditActorType.CUSTOMER,
          actorId: `customer:${claim.customerId}`,
          entityType: "Job",
          entityId: claim.id,
          metadata: { notificationIntentId: intent.id },
        },
      });
      return intent;
    });
    try {
      await this.intents.processOne({
        tenantId: claim.tenantId,
        intentId: intent.id,
      });
    } catch {
      this.logDeferred(claim.id);
    }
  }

  logDeferred(jobId: string) {
    try {
      this.logging.error(
        `appointment_cancellation_review_or_notification_deferred job=${jobId}`,
        undefined,
        AppointmentCancellationService.name,
      );
    } catch {
      /* Logging cannot reverse a committed cancellation. */
    }
  }
}
