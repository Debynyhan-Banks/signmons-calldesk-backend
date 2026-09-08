import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { JobStatus, TechnicianJobStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SmsDeliveryService } from "./sms-delivery.service";
import {
  TransactionalMessageTemplateKey,
  TransactionalMessageTemplateService,
} from "./transactional-message-template.service";

@Injectable()
export class TransactionalMessagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: TransactionalMessageTemplateService,
    private readonly delivery: SmsDeliveryService,
  ) {}

  async queue(input: {
    tenantId: string;
    jobId: string;
    templateKey: TransactionalMessageTemplateKey;
    idempotencyKey: string;
  }) {
    const job = await this.prisma.job.findUnique({
      where: { id_tenantId: { id: input.jobId, tenantId: input.tenantId } },
      select: {
        id: true,
        status: true,
        deletedAt: true,
        technicianStatus: true,
        calendarEventId: true,
        serviceWindowStart: true,
        serviceWindowEnd: true,
        tenant: { select: { name: true, timezone: true } },
        customer: { select: { phone: true } },
        assignedUser: { select: { fullName: true } },
      },
    });
    if (!job || job.deletedAt)
      throw new NotFoundException("Job was not found.");

    const cancellation =
      input.templateKey ===
      TransactionalMessageTemplateKey.APPOINTMENT_CANCELLED;
    const onTheWay =
      input.templateKey ===
      TransactionalMessageTemplateKey.TECHNICIAN_ON_THE_WAY;
    if (
      cancellation
        ? job.status !== JobStatus.CANCELLED
        : job.status === JobStatus.CANCELLED ||
          job.status === JobStatus.COMPLETED
    ) {
      throw new ConflictException(
        "Message does not match the current job status.",
      );
    }
    if (
      onTheWay &&
      (!job.assignedUser ||
        job.technicianStatus !== TechnicianJobStatus.EN_ROUTE)
    ) {
      throw new ConflictException("The assigned technician is not on the way.");
    }
    if (
      !cancellation &&
      !onTheWay &&
      (!job.calendarEventId ||
        !job.serviceWindowStart ||
        !job.serviceWindowEnd ||
        job.serviceWindowEnd.getTime() <= job.serviceWindowStart.getTime())
    ) {
      throw new ConflictException(
        "Message requires a committed appointment window.",
      );
    }

    const rendered = this.templates.render(input.templateKey, {
      contractorName: job.tenant.name,
      appointmentTime: job.serviceWindowStart,
      timeZone: job.tenant.timezone,
      technicianName: job.assignedUser?.fullName,
    });

    return this.delivery.create({
      tenantId: input.tenantId,
      jobId: job.id,
      to: job.customer.phone,
      body: rendered.body,
      idempotencyKey: input.idempotencyKey,
      templateId: rendered.templateId,
      templateKey: rendered.templateKey,
      templateVersion: rendered.templateVersion,
    });
  }
}
