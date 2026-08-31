import { randomUUID } from "crypto";
import {
  Controller,
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
import { JobOperationsAccessGuard } from "./job-operations-access.guard";

const UUID_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller("jobs")
@UseGuards(RequestAuthGuard, TenantGuard, JobOperationsAccessGuard)
export class JobsController {
  constructor(private readonly jobLifecycleService: JobLifecycleService) {}

  @Post(":jobId/complete")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 20, ttl: 60 } })
  completeJob(@Param("jobId", new ParseUUIDPipe()) jobId: string) {
    const context = getRequestContext();
    if (!context?.tenantId || !context.userId) {
      throw new UnauthorizedException("Operator context is missing.");
    }
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
}
