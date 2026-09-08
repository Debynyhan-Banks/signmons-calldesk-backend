import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuditActorType, SmsEnqueueIntentStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  EnqueueRetryReason,
  parseEnqueueIntentTemplate,
  SMS_ENQUEUE_MAX_FAILURES,
} from "./sms-enqueue-intent-policy";
import {
  evaluateTransactionalMessageState,
  transactionalMessageJobSelect,
  transactionalMessageStateHash,
} from "./transactional-message-state";

@Injectable()
export class SmsEnqueueRecoveryService {
  constructor(private readonly prisma: PrismaService) {}

  async retry(input: {
    tenantId: string;
    intentId: string;
    actorId: string;
    acknowledgeRetry: boolean;
    reasonCode: EnqueueRetryReason;
    expectedUpdatedAt: string;
  }): Promise<{ status: "pending" }> {
    const expected = new Date(input.expectedUpdatedAt);
    if (
      input.acknowledgeRetry !== true ||
      !Object.values(EnqueueRetryReason).includes(input.reasonCode) ||
      !Number.isFinite(expected.getTime()) ||
      expected.toISOString() !== input.expectedUpdatedAt
    ) {
      throw new BadRequestException(
        "Retry requires acknowledgment, a supported review reason and the current record timestamp.",
      );
    }
    await this.prisma.$transaction(async (transaction) => {
      const intent = await transaction.smsEnqueueIntent.findUnique({
        where: {
          id_tenantId: { id: input.intentId, tenantId: input.tenantId },
        },
      });
      if (!intent) throw new NotFoundException("Enqueue intent not found.");
      if (
        intent.status !== SmsEnqueueIntentStatus.FAILED ||
        intent.attemptCount !== SMS_ENQUEUE_MAX_FAILURES ||
        intent.communicationEventId !== null ||
        intent.updatedAt.getTime() !== expected.getTime()
      ) {
        throw new ConflictException(
          "Only the current exhausted, unacknowledged intent can be retried. Refresh intent status.",
        );
      }
      const templateKey = parseEnqueueIntentTemplate(intent.templateKey);
      const job = await transaction.job.findUnique({
        where: { id_tenantId: { id: intent.jobId, tenantId: input.tenantId } },
        select: transactionalMessageJobSelect,
      });
      if (
        !templateKey ||
        !job ||
        evaluateTransactionalMessageState(templateKey, job) !== "AVAILABLE" ||
        transactionalMessageStateHash(templateKey, job) !== intent.stateHash
      ) {
        throw new ConflictException(
          "The recorded notification no longer matches current job state. Retry is not permitted.",
        );
      }
      const reset = await transaction.smsEnqueueIntent.updateMany({
        where: {
          id: input.intentId,
          tenantId: input.tenantId,
          status: SmsEnqueueIntentStatus.FAILED,
          attemptCount: SMS_ENQUEUE_MAX_FAILURES,
          communicationEventId: null,
          updatedAt: expected,
        },
        data: {
          status: SmsEnqueueIntentStatus.PENDING,
          attemptCount: 0,
          lastErrorCode: null,
          nextAttemptAt: new Date(),
        },
      });
      if (reset.count !== 1)
        throw new ConflictException(
          "The intent changed during review. Refresh intent status.",
        );
      await transaction.auditLog.create({
        data: {
          tenantId: input.tenantId,
          action: "communication.enqueue_intent_retry_requested",
          actorType: AuditActorType.USER,
          actorId: input.actorId,
          entityType: "SmsEnqueueIntent",
          entityId: input.intentId,
          metadata: {
            jobId: intent.jobId,
            templateKey,
            reasonCode: input.reasonCode,
            acknowledged: true,
            previousAttemptCount: intent.attemptCount,
            reviewedUpdatedAt: input.expectedUpdatedAt,
          },
        },
      });
    });
    // Re-arm only. The worker still enforces delivery enablement, canonical
    // queue identity, current state, consent and quiet hours; this API never sends.
    return { status: "pending" };
  }
}
