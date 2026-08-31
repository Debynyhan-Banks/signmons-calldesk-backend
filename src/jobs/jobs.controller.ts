import { randomUUID } from "crypto";
import {
  Controller,
  Get,
  Header,
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
import { JobLifecycleService } from "./job-lifecycle.service";
import { IntakeReadinessService } from "./intake-readiness.service";
import { IntakeReviewAccessGuard } from "./intake-review-access.guard";
import { JobOperationsAccessGuard } from "./job-operations-access.guard";

const UUID_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller("jobs")
@UseGuards(RequestAuthGuard, TenantGuard)
export class JobsController {
  constructor(
    private readonly jobLifecycleService: JobLifecycleService,
    private readonly intakeReadinessService: IntakeReadinessService,
  ) {}

  @Get("intake-review")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 60, ttl: 60 } })
  @UseGuards(IntakeReviewAccessGuard)
  listIntakeReviews() {
    const context = this.operatorContext();
    return this.intakeReadinessService.list(context.tenantId);
  }

  @Get("intake-review/:jobId")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 60, ttl: 60 } })
  @UseGuards(IntakeReviewAccessGuard)
  getIntakeReview(@Param("jobId", new ParseUUIDPipe()) jobId: string) {
    const context = this.operatorContext();
    return this.intakeReadinessService.get(context.tenantId, jobId);
  }

  @Post(":jobId/readiness/review")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 30, ttl: 60 } })
  @UseGuards(IntakeReviewAccessGuard)
  reviewReadiness(@Param("jobId", new ParseUUIDPipe()) jobId: string) {
    const context = this.operatorContext();
    return this.intakeReadinessService.review({
      tenantId: context.tenantId,
      jobId,
      actorId: context.userId,
      traceId:
        context.requestId && UUID_REQUEST_ID.test(context.requestId)
          ? context.requestId
          : randomUUID(),
    });
  }

  @Post(":jobId/complete")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 20, ttl: 60 } })
  @UseGuards(JobOperationsAccessGuard)
  completeJob(@Param("jobId", new ParseUUIDPipe()) jobId: string) {
    const context = this.operatorContext();
    return this.jobLifecycleService.completeJob({
      tenantId: context.tenantId,
      jobId,
      actorId: context.userId,
      traceId:
        context.requestId && UUID_REQUEST_ID.test(context.requestId)
          ? context.requestId
          : randomUUID(),
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
}
