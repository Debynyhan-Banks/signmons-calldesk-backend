import { ConflictException, Injectable } from "@nestjs/common";
import { AuditActorType, Job, JobStatus } from "@prisma/client";
import { SmsEnqueueIntentService } from "../communications/sms-enqueue-intent.service";
import { LoggingService } from "../logging/logging.service";
import { PrismaService } from "../prisma/prisma.service";

// Local reservation and post-Calendar finalization only; never calls Calendar.
@Injectable()
export class AppointmentReschedulingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly intents: SmsEnqueueIntentService,
    private readonly logging: LoggingService,
  ) {}

  claim(job: Job, start: Date, end: Date, label: string) {
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
          serviceWindowStart: start,
          serviceWindowEnd: end,
          preferredTimeText: label,
          // A new claim must not reuse a prior finalization's replay proof.
          updatedAt: new Date(
            Math.max(Date.now(), job.updatedAt.getTime() + 1),
          ),
        },
      });
      if (changed.count !== 1)
        throw new ConflictException("Appointment changed before rescheduling.");
      return tx.job.findUniqueOrThrow({
        where: { id_tenantId: { id: job.id, tenantId: job.tenantId } },
      });
    });
  }

  restore(claim: Job, original: Job) {
    return this.prisma.job.updateMany({
      where: this.claimWhere(claim),
      data: {
        serviceWindowStart: original.serviceWindowStart,
        serviceWindowEnd: original.serviceWindowEnd,
        preferredTimeText: original.preferredTimeText,
        updatedAt: new Date(
          Math.max(Date.now(), claim.updatedAt.getTime() + 1),
        ),
      },
    });
  }

  async assertFinalized(job: Job) {
    const proof = await this.prisma.auditLog.findFirst({
      where: {
        tenantId: job.tenantId,
        entityType: "Job",
        entityId: job.id,
        action: "appointment.customer_rescheduled",
        actorType: AuditActorType.CUSTOMER,
        metadata: {
          path: ["finalizedUpdatedAt"],
          equals: job.updatedAt.toISOString(),
        },
      },
      select: { id: true },
    });
    if (!proof)
      throw new ConflictException(
        "This reschedule needs confirmation by the office. Please contact the office before trying again.",
      );
  }

  async finalize(
    claim: Job,
    previousAppointmentLabel: string,
    appointmentLabel: string,
  ) {
    const finalizedUpdatedAt = new Date(
      Math.max(Date.now(), claim.updatedAt.getTime() + 1),
    );
    const intent = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.job.updateMany({
        where: this.claimWhere(claim),
        data: { updatedAt: finalizedUpdatedAt },
      });
      if (changed.count !== 1)
        throw new ConflictException("Reschedule changed before finalization.");
      const intent = await this.intents.recordReschedule(tx, {
        tenantId: claim.tenantId,
        jobId: claim.id,
      });
      await tx.auditLog.create({
        data: {
          tenantId: claim.tenantId,
          action: "appointment.customer_rescheduled",
          actorType: AuditActorType.CUSTOMER,
          actorId: `customer:${claim.customerId}`,
          entityType: "Job",
          entityId: claim.id,
          metadata: {
            previousAppointmentLabel,
            appointmentLabel,
            notificationIntentId: intent.id,
            finalizedUpdatedAt: finalizedUpdatedAt.toISOString(),
          },
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

  private claimWhere(claim: Job) {
    return {
      id: claim.id,
      tenantId: claim.tenantId,
      deletedAt: null,
      status: JobStatus.ACCEPTED,
      calendarEventId: claim.calendarEventId,
      serviceWindowStart: claim.serviceWindowStart,
      serviceWindowEnd: claim.serviceWindowEnd,
      updatedAt: claim.updatedAt,
    };
  }

  logDeferred(jobId: string) {
    try {
      this.logging.error(
        `appointment_reschedule_review_or_notification_deferred job=${jobId}`,
        undefined,
        AppointmentReschedulingService.name,
      );
    } catch {
      /* Logging cannot reverse an acknowledged, finalized reschedule. */
    }
  }
}
