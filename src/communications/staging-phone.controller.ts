import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Header,
  HttpException,
  Post,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { IsObject, IsOptional } from "class-validator";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { RequestAuthGuard } from "../auth/request-auth.guard";
import { TenantGuard } from "../common/guards/tenant.guard";
import { StagingPhoneService } from "./staging-phone.service";
import type { VerificationOptIn } from "./verification-budget-admission";

class StagingPhoneRequest {
  @IsObject() operation!: Record<string, unknown>;
  @IsOptional() @IsObject() optIn?: VerificationOptIn;
}
/** No exception, URL, request body, OTP or token logging on this sensitive route. */
@Catch()
export class StagingPhoneFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const status = error instanceof HttpException ? error.getStatus() : 503;
    host
      .switchToHttp()
      .getResponse<Response>()
      .setHeader("Cache-Control", "private, no-store")
      .status(status)
      .json({
        statusCode: status,
        message: "Staging phone test unavailable. Do not resend automatically.",
      });
  }
}
@Controller("communications/staging-phone-test")
@UseGuards(RequestAuthGuard, TenantGuard)
@UseFilters(StagingPhoneFilter)
export class StagingPhoneController {
  constructor(private readonly phone: StagingPhoneService) {}
  @Post("operations")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  execute(@Body() body: StagingPhoneRequest) {
    return this.phone.execute(body.operation, body.optIn);
  }
  @Post("stop")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  stop() {
    return this.phone.stop();
  }
}
