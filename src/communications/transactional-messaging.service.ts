import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CalendarOperationPendingError } from "../scheduling/calendar-operation-guard";
import { SmsDeliveryService } from "./sms-delivery.service";
import {
  TransactionalMessageTemplateKey,
  TransactionalMessageTemplateService,
} from "./transactional-message-template.service";
import {
  evaluateTransactionalMessageState,
  transactionalMessageJobSelect,
  transactionalMessageStateHash,
  type TransactionalMessageJob,
} from "./transactional-message-state";

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
    const job = await this.loadJob(input.tenantId, input.jobId);
    return this.create({ ...input, job });
  }

  async queueLifecycle(input: {
    tenantId: string;
    jobId: string;
    templateKey: TransactionalMessageTemplateKey;
    expectedStateHash?: string;
  }) {
    const job = await this.loadJob(input.tenantId, input.jobId).catch(
      (error: unknown) => {
        if (input.expectedStateHash && error instanceof NotFoundException)
          throw new StaleMessageIntentError();
        throw error;
      },
    );
    if (
      evaluateTransactionalMessageState(input.templateKey, job) ===
      "CALENDAR_PENDING"
    ) {
      throw new CalendarOperationPendingError();
    }
    const stateHash = transactionalMessageStateHash(input.templateKey, job);
    if (
      input.expectedStateHash &&
      (stateHash !== input.expectedStateHash ||
        evaluateTransactionalMessageState(input.templateKey, job) !==
          "AVAILABLE")
    ) {
      throw new StaleMessageIntentError();
    }
    return this.create({
      ...input,
      job,
      idempotencyKey: `lifecycle:${input.templateKey}:${stateHash}`,
    });
  }

  private async loadJob(
    tenantId: string,
    jobId: string,
  ): Promise<TransactionalMessageJob> {
    const job = await this.prisma.job.findUnique({
      where: { id_tenantId: { id: jobId, tenantId } },
      select: transactionalMessageJobSelect,
    });
    if (!job || job.deletedAt) {
      throw new NotFoundException("Job was not found.");
    }
    return job;
  }

  private create(input: {
    tenantId: string;
    jobId: string;
    templateKey: TransactionalMessageTemplateKey;
    idempotencyKey: string;
    job: TransactionalMessageJob;
  }) {
    if (
      evaluateTransactionalMessageState(input.templateKey, input.job) !==
      "AVAILABLE"
    ) {
      throw new ConflictException(
        "Message does not match the current job status.",
      );
    }

    const rendered = this.templates.render(input.templateKey, {
      contractorName: input.job.tenant.name,
      appointmentTime: input.job.serviceWindowStart,
      timeZone: input.job.tenant.timezone,
      technicianName: input.job.assignedUser?.fullName,
    });

    return this.delivery.create({
      tenantId: input.tenantId,
      jobId: input.job.id,
      to: input.job.customer.phone,
      body: rendered.body,
      idempotencyKey: input.idempotencyKey,
      templateId: rendered.templateId,
      templateKey: rendered.templateKey,
      templateVersion: rendered.templateVersion,
      lifecycleStateHash: transactionalMessageStateHash(
        input.templateKey,
        input.job,
      ),
    });
  }
}

export class StaleMessageIntentError extends Error {}
