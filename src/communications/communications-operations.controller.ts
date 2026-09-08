import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { RequestAuthGuard } from "../auth/request-auth.guard";
import { getRequestContext } from "../common/context/request-context";
import { TenantGuard } from "../common/guards/tenant.guard";
import { CommunicationsOperationsAccessGuard } from "./communications-operations-access.guard";
import {
  canReplayCommunications,
  CommunicationsReplayAccessGuard,
} from "./communications-replay-access.guard";
import { QueueTransactionalMessageDto } from "./dto/queue-transactional-message.dto";
import { ReplaySmsDto } from "./dto/replay-sms.dto";
import { SmsDeliveryService } from "./sms-delivery.service";
import { TransactionalMessagingService } from "./transactional-messaging.service";
import { SmsEnqueueIntentService } from "./sms-enqueue-intent.service";
import { SmsEnqueueRecoveryService } from "./sms-enqueue-recovery.service";
import { RetryEnqueueIntentDto } from "./dto/retry-enqueue-intent.dto";

@Controller("communications/sms")
@UseGuards(RequestAuthGuard, TenantGuard, CommunicationsOperationsAccessGuard)
export class CommunicationsOperationsController {
  constructor(
    private readonly delivery: SmsDeliveryService,
    private readonly transactional: TransactionalMessagingService,
    private readonly intents: SmsEnqueueIntentService,
    private readonly recovery: SmsEnqueueRecoveryService,
  ) {}

  @Post("transactional")
  @HttpCode(202)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 10, ttl: 60 } })
  queueTransactional(@Body() body: QueueTransactionalMessageDto) {
    return this.transactional.queue({
      tenantId: this.context().tenantId,
      jobId: body.jobId,
      templateKey: body.templateKey,
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Get("history")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 30, ttl: 60 } })
  history(
    @Query("jobId") jobId?: string,
    @Query("limit", new ParseIntPipe({ optional: true })) limit = 50,
  ) {
    if (
      jobId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        jobId,
      )
    ) {
      throw new BadRequestException("History job filter is invalid.");
    }
    if (limit < 1 || limit > 100) {
      throw new BadRequestException("History limit must be 1 to 100.");
    }
    return this.delivery.listHistory({
      tenantId: this.context().tenantId,
      jobId,
      limit,
    });
  }

  @Get("capabilities")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  capabilities() {
    this.context();
    return {
      canRetryEnqueueIntent: canReplayCommunications(getRequestContext()?.role),
    };
  }

  @Get("enqueue-intents")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 30, ttl: 60 } })
  enqueueIntents() {
    return this.intents.list(this.context().tenantId);
  }

  @Get("dead-letters")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 30, ttl: 60 } })
  listDeadLetters() {
    return this.delivery.listDeadLetters(this.context().tenantId);
  }

  @Post("enqueue-intents/:intentId/retry")
  @HttpCode(202)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(CommunicationsReplayAccessGuard)
  retryEnqueueIntent(
    @Param("intentId", new ParseUUIDPipe()) intentId: string,
    @Body() body: RetryEnqueueIntentDto,
  ): Promise<{ status: "pending" }> {
    const context = this.context();
    return this.recovery.retry({
      tenantId: context.tenantId,
      actorId: context.userId,
      intentId,
      acknowledgeRetry: body.acknowledgeRetry,
      reasonCode: body.reasonCode,
      expectedUpdatedAt: body.expectedUpdatedAt,
    });
  }

  @Get("metrics")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 30, ttl: 60 } })
  metrics(@Query("days") rawDays?: string) {
    const days = rawDays === undefined ? 30 : Number(rawDays);
    return this.delivery.metrics(this.context().tenantId, days);
  }

  @Post("dead-letters/:eventId/replay")
  @HttpCode(202)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 5, ttl: 60 } })
  @UseGuards(CommunicationsReplayAccessGuard)
  async replay(
    @Param("eventId", new ParseUUIDPipe()) eventId: string,
    @Body() body: ReplaySmsDto,
  ): Promise<{ status: "queued" }> {
    const context = this.context();
    await this.delivery.replayDeadLetter({
      tenantId: context.tenantId,
      eventId,
      actorId: context.userId,
      acknowledgeDuplicateRisk: body.acknowledgeDuplicateRisk,
      reason: body.reason,
    });
    return { status: "queued" };
  }

  private context(): { tenantId: string; userId: string } {
    const context = getRequestContext();
    if (!context?.tenantId || !context.userId) {
      throw new UnauthorizedException("Operator context is missing.");
    }
    return { tenantId: context.tenantId, userId: context.userId };
  }
}
