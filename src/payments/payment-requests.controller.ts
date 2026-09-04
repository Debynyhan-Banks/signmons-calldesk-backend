import { randomUUID } from "crypto";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { RequestAuthGuard } from "../auth/request-auth.guard";
import { getRequestContext } from "../common/context/request-context";
import { TenantGuard } from "../common/guards/tenant.guard";
import { CreatePaymentRequestDto } from "./dto/create-payment-request.dto";
import { PaymentOperationsAccessGuard } from "./payment-operations-access.guard";
import { PaymentRequestsService } from "./payment-requests.service";

const UUID_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller("jobs")
@UseGuards(RequestAuthGuard, TenantGuard, PaymentOperationsAccessGuard)
export class PaymentRequestsController {
  constructor(private readonly payments: PaymentRequestsService) {}

  @Get(":jobId/payment-request")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 60, ttl: 60 } })
  getPaymentRequest(@Param("jobId", new ParseUUIDPipe()) jobId: string) {
    return this.payments.get(this.operatorContext().tenantId, jobId);
  }

  @Post(":jobId/payment-requests")
  @HttpCode(201)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 10, ttl: 60 } })
  createPaymentRequest(
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: CreatePaymentRequestDto,
  ) {
    const context = this.operatorContext();
    if (!idempotencyKey || !UUID_V4.test(idempotencyKey)) {
      throw new BadRequestException(
        "Idempotency-Key must be a version 4 UUID.",
      );
    }
    return this.payments.create({
      tenantId: context.tenantId,
      jobId,
      actorId: context.userId,
      traceId: this.traceId(context.requestId),
      idempotencyKey,
      expectedJobUpdatedAt: body.expectedJobUpdatedAt,
    });
  }

  private operatorContext(): {
    tenantId: string;
    userId: string;
    requestId?: string;
  } {
    const context = getRequestContext();
    if (!context?.tenantId || !context.userId) {
      throw new UnauthorizedException("Operator context is missing.");
    }
    return {
      tenantId: context.tenantId,
      userId: context.userId,
      requestId: context.requestId,
    };
  }

  private traceId(requestId?: string): string {
    return requestId && UUID_REQUEST_ID.test(requestId)
      ? requestId
      : randomUUID();
  }
}
