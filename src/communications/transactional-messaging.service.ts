import { Injectable, NotFoundException } from "@nestjs/common";
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
        serviceWindowStart: true,
        tenant: { select: { name: true, timezone: true } },
        customer: { select: { phone: true } },
        assignedUser: { select: { fullName: true } },
      },
    });
    if (!job) throw new NotFoundException("Job was not found.");

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
