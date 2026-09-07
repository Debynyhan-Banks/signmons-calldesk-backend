import {
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
  Body,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { RequestAuthGuard } from "../auth/request-auth.guard";
import { getRequestContext } from "../common/context/request-context";
import { TenantGuard } from "../common/guards/tenant.guard";
import { CommunicationsOperationsAccessGuard } from "./communications-operations-access.guard";
import { CommunicationsReplayAccessGuard } from "./communications-replay-access.guard";
import { ReplaySmsDto } from "./dto/replay-sms.dto";
import { SmsDeliveryService } from "./sms-delivery.service";

@Controller("communications/sms")
@UseGuards(RequestAuthGuard, TenantGuard, CommunicationsOperationsAccessGuard)
export class CommunicationsOperationsController {
  constructor(private readonly delivery: SmsDeliveryService) {}

  @Get("dead-letters")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 30, ttl: 60 } })
  listDeadLetters() {
    return this.delivery.listDeadLetters(this.context().tenantId);
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
