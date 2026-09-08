import { ConflictException, Injectable } from "@nestjs/common";
import { AuditActorType, JobStatus } from "@prisma/client";
import { SmsEnqueueIntentService } from "../communications/sms-enqueue-intent.service";
import { LoggingService } from "../logging/logging.service";
import { PrismaService } from "../prisma/prisma.service";
import { noUnfinishedCalendarOperations } from "./calendar-operation-guard";

// Finalizes local booking evidence after the calendar has acknowledged insertion.
// The external calendar operation is deliberately outside the database transaction.
@Injectable()
export class AppointmentConfirmationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly intents: SmsEnqueueIntentService,
    private readonly logging: LoggingService,
  ) {}

  async finalize(input: {
    tenantId: string;
    jobId: string;
    start: Date;
    end: Date;
    calendarEventId: string;
  }) {
    const { confirmed, intent } = await this.prisma.$transaction(
      async (transaction) => {
        const updated = await transaction.job.updateMany({
          where: {
            calendarOperations: noUnfinishedCalendarOperations,
            id: input.jobId,
            tenantId: input.tenantId,
            status: JobStatus.ACCEPTED,
            deletedAt: null,
            calendarEventId: null,
            serviceWindowStart: input.start,
            serviceWindowEnd: input.end,
          },
          data: { calendarEventId: input.calendarEventId },
        });
        if (updated.count !== 1)
          throw new ConflictException(
            "Appointment reservation changed before finalization.",
          );
        const confirmed = await transaction.job.findUniqueOrThrow({
          where: { id_tenantId: { id: input.jobId, tenantId: input.tenantId } },
          include: {
            customer: true,
            propertyAddress: true,
            serviceCategory: true,
          },
        });
        const intent = await this.intents.recordConfirmation(transaction, {
          tenantId: input.tenantId,
          jobId: input.jobId,
        });
        await transaction.auditLog.create({
          data: {
            tenantId: input.tenantId,
            action: "appointment.initial_confirmed",
            actorType: AuditActorType.CUSTOMER,
            actorId: `customer:${confirmed.customerId}`,
            entityType: "Job",
            entityId: input.jobId,
            metadata: { notificationIntentId: intent.id },
          },
        });
        return { confirmed, intent };
      },
    );
    try {
      await this.intents.processOne({
        tenantId: input.tenantId,
        intentId: intent.id,
      });
    } catch {
      try {
        this.logging.error(
          `appointment_confirmation_enqueue_deferred tenant=${input.tenantId} job=${input.jobId}`,
          undefined,
          AppointmentConfirmationService.name,
        );
      } catch {
        // Neither queue processing nor its logging can undo the booking commit.
      }
    }
    return confirmed;
  }
}
