import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { CustomerSmsPreferenceError } from "./customer-messaging-policy";
import type { ConfigType } from "@nestjs/config";
import { Prisma, SmsEnqueueIntentStatus } from "@prisma/client";
import appConfig from "../config/app.config";
import { PrismaService } from "../prisma/prisma.service";
import { CalendarOperationPendingError } from "../scheduling/calendar-operation-guard";
import { TransactionalMessageTemplateKey } from "./transactional-message-template.service";
import {
  evaluateTransactionalMessageState,
  transactionalMessageJobSelect,
  transactionalMessageStateHash,
} from "./transactional-message-state";
import {
  StaleMessageIntentError,
  TransactionalMessagingService,
} from "./transactional-messaging.service";
import {
  parseEnqueueIntentTemplate,
  SMS_ENQUEUE_MAX_FAILURES,
} from "./sms-enqueue-intent-policy";
const LEASE_MS = 60_000;

@Injectable()
export class SmsEnqueueIntentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: TransactionalMessagingService,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  recordDeparture(
    transaction: Prisma.TransactionClient,
    input: { tenantId: string; jobId: string },
  ) {
    return this.record(
      transaction,
      input,
      TransactionalMessageTemplateKey.TECHNICIAN_ON_THE_WAY,
    );
  }

  recordConfirmation(
    transaction: Prisma.TransactionClient,
    input: { tenantId: string; jobId: string },
  ) {
    return this.record(
      transaction,
      input,
      TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED,
    );
  }

  recordCancellation(
    transaction: Prisma.TransactionClient,
    input: { tenantId: string; jobId: string },
  ) {
    return this.record(
      transaction,
      input,
      TransactionalMessageTemplateKey.APPOINTMENT_CANCELLED,
    );
  }

  recordReschedule(
    transaction: Prisma.TransactionClient,
    input: { tenantId: string; jobId: string },
  ) {
    return this.record(
      transaction,
      input,
      TransactionalMessageTemplateKey.APPOINTMENT_RESCHEDULED,
    );
  }

  private async record(
    transaction: Prisma.TransactionClient,
    input: { tenantId: string; jobId: string },
    templateKey: TransactionalMessageTemplateKey,
  ) {
    const job = await transaction.job.findUnique({
      where: { id_tenantId: { id: input.jobId, tenantId: input.tenantId } },
      select: transactionalMessageJobSelect,
    });
    if (
      !job ||
      evaluateTransactionalMessageState(templateKey, job) !== "AVAILABLE"
    )
      throw new ConflictException(
        "Notification intent requires a current compatible job state.",
      );
    const key = {
      ...input,
      templateKey,
      stateHash: transactionalMessageStateHash(templateKey, job),
    };
    return transaction.smsEnqueueIntent.upsert({
      where: { tenantId_jobId_templateKey_stateHash: key },
      create: key,
      update: {},
      select: { id: true },
    });
  }

  async processDue(): Promise<number> {
    if (!this.config.smsDeliveryEnabled) return 0;
    const due = await this.prisma.smsEnqueueIntent.findMany({
      where: {
        status: SmsEnqueueIntentStatus.PENDING,
        nextAttemptAt: { lte: new Date() },
      },
      orderBy: { nextAttemptAt: "asc" },
      take: 25,
      select: { id: true, tenantId: true },
    });
    await Promise.allSettled(
      due.map((intent) =>
        this.processOne({ tenantId: intent.tenantId, intentId: intent.id }),
      ),
    );
    return due.length;
  }

  async processOne(input: {
    tenantId: string;
    intentId: string;
  }): Promise<void> {
    if (!this.config.smsDeliveryEnabled) return;
    const now = new Date();
    const intent = await this.prisma.smsEnqueueIntent.findUnique({
      where: { id_tenantId: { id: input.intentId, tenantId: input.tenantId } },
    });
    if (
      !intent ||
      intent.status !== SmsEnqueueIntentStatus.PENDING ||
      intent.nextAttemptAt > now
    )
      return;
    const lease = new Date(now.getTime() + LEASE_MS);
    const claimed = await this.prisma.smsEnqueueIntent.updateMany({
      where: {
        id: intent.id,
        tenantId: input.tenantId,
        status: SmsEnqueueIntentStatus.PENDING,
        nextAttemptAt: { lte: now },
      },
      data: { nextAttemptAt: lease },
    });
    if (claimed.count !== 1) return;
    const ownership = {
      id: intent.id,
      tenantId: input.tenantId,
      status: SmsEnqueueIntentStatus.PENDING,
      nextAttemptAt: lease,
    };
    try {
      const templateKey = parseEnqueueIntentTemplate(intent.templateKey);
      if (!templateKey) throw new StaleMessageIntentError();
      const event = await this.messaging.queueLifecycle({
        tenantId: intent.tenantId,
        jobId: intent.jobId,
        templateKey,
        expectedStateHash: intent.stateHash,
      });
      await this.prisma.smsEnqueueIntent.updateMany({
        where: ownership,
        data: {
          status: SmsEnqueueIntentStatus.QUEUED,
          communicationEventId: event.id,
          lastErrorCode: null,
        },
      });
    } catch (error) {
      if (error instanceof CalendarOperationPendingError) {
        await this.prisma.smsEnqueueIntent.updateMany({
          where: ownership,
          data: {
            lastErrorCode: "calendar_sync_pending",
            nextAttemptAt: lease,
          },
        });
        return;
      }
      const suppressed = error instanceof CustomerSmsPreferenceError;
      const stale = error instanceof StaleMessageIntentError || suppressed;
      const failures = Math.min(
        intent.attemptCount + 1,
        SMS_ENQUEUE_MAX_FAILURES,
      );
      await this.prisma.smsEnqueueIntent.updateMany({
        where: ownership,
        data: {
          status: stale
            ? SmsEnqueueIntentStatus.STALE
            : failures >= SMS_ENQUEUE_MAX_FAILURES
              ? SmsEnqueueIntentStatus.FAILED
              : SmsEnqueueIntentStatus.PENDING,
          attemptCount: failures,
          lastErrorCode: suppressed
            ? "suppressed_tenant_preference"
            : stale
              ? "stale_lifecycle_state"
              : "enqueue_failed",
          nextAttemptAt: new Date(now.getTime() + LEASE_MS * 2 ** failures),
        },
      });
    }
  }

  list(tenantId: string) {
    return this.prisma.smsEnqueueIntent.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        jobId: true,
        templateKey: true,
        status: true,
        attemptCount: true,
        lastErrorCode: true,
        nextAttemptAt: true,
        communicationEventId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }
}
