import { randomUUID } from "crypto";
import {
  Controller,
  Body,
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
import { OverrideJobUrgencyDto } from "./dto/override-job-urgency.dto";
import { UrgencyReviewAccessGuard } from "./urgency-review-access.guard";
import { UrgencyReviewService } from "./urgency-review.service";
import { AssignJobDto } from "./dto/assign-job.dto";
import { CancelJobAssignmentDto } from "./dto/cancel-job-assignment.dto";
import { DispatchAccessGuard } from "./dispatch-access.guard";
import { DispatchBoardService } from "./dispatch-board.service";

const UUID_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller("jobs")
@UseGuards(RequestAuthGuard, TenantGuard)
export class JobsController {
  constructor(
    private readonly jobLifecycleService: JobLifecycleService,
    private readonly intakeReadinessService: IntakeReadinessService,
    private readonly urgencyReviewService: UrgencyReviewService,
    private readonly dispatchBoardService: DispatchBoardService,
  ) {}

  @Get("dispatch-board")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 60, ttl: 60 } })
  @UseGuards(DispatchAccessGuard)
  listDispatchBoard() {
    const context = this.operatorContext();
    return this.dispatchBoardService.list(context.tenantId);
  }

  @Get("dispatch-board/:jobId")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 60, ttl: 60 } })
  @UseGuards(DispatchAccessGuard)
  getDispatchJob(@Param("jobId", new ParseUUIDPipe()) jobId: string) {
    const context = this.operatorContext();
    return this.dispatchBoardService.get(context.tenantId, jobId);
  }

  @Post(":jobId/assignments")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 30, ttl: 60 } })
  @UseGuards(DispatchAccessGuard)
  assignJob(
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
    @Body() body: AssignJobDto,
  ) {
    const context = this.operatorContext();
    return this.dispatchBoardService.assign({
      tenantId: context.tenantId,
      jobId,
      actorId: context.userId,
      technicianId: body.technicianId,
      expectedUpdatedAt: body.expectedUpdatedAt,
      reason: body.reason,
      traceId: this.traceId(context.requestId),
    });
  }

  @Post(":jobId/assignments/cancel")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 20, ttl: 60 } })
  @UseGuards(DispatchAccessGuard)
  cancelJobAssignment(
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
    @Body() body: CancelJobAssignmentDto,
  ) {
    const context = this.operatorContext();
    return this.dispatchBoardService.cancelAssignment({
      tenantId: context.tenantId,
      jobId,
      actorId: context.userId,
      expectedUpdatedAt: body.expectedUpdatedAt,
      reason: body.reason,
      traceId: this.traceId(context.requestId),
    });
  }

  @Get("urgency-review")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 60, ttl: 60 } })
  @UseGuards(UrgencyReviewAccessGuard)
  listUrgencyReviews() {
    const context = this.operatorContext();
    return this.urgencyReviewService.list(context.tenantId);
  }

  @Get("urgency-review/:jobId")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 60, ttl: 60 } })
  @UseGuards(UrgencyReviewAccessGuard)
  getUrgencyReview(@Param("jobId", new ParseUUIDPipe()) jobId: string) {
    const context = this.operatorContext();
    return this.urgencyReviewService.get(context.tenantId, jobId);
  }

  @Post(":jobId/urgency/override")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 20, ttl: 60 } })
  @UseGuards(UrgencyReviewAccessGuard)
  overrideUrgency(
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
    @Body() body: OverrideJobUrgencyDto,
  ) {
    const context = this.operatorContext();
    return this.urgencyReviewService.override({
      tenantId: context.tenantId,
      jobId,
      actorId: context.userId,
      urgency: body.urgency,
      reason: body.reason,
      traceId: this.traceId(context.requestId),
    });
  }

  @Post(":jobId/escalations")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 10, ttl: 60 } })
  @UseGuards(UrgencyReviewAccessGuard)
  escalateUrgency(@Param("jobId", new ParseUUIDPipe()) jobId: string) {
    const context = this.operatorContext();
    return this.urgencyReviewService.escalate({
      tenantId: context.tenantId,
      jobId,
      actorId: context.userId,
      traceId: this.traceId(context.requestId),
    });
  }

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
      traceId: this.traceId(context.requestId),
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
      traceId: this.traceId(context.requestId),
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
