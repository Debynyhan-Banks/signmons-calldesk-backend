import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { RequestAuthGuard } from "../auth/request-auth.guard";
import { TenantGuard } from "../common/guards/tenant.guard";
import { CalendarReviewAccessGuard } from "./calendar-review-access.guard";
import { CalendarReviewHttpFilter } from "./calendar-review-http.filter";
import { CalendarReviewStateService } from "./calendar-review-state.service";

/** Test-composed only. Deliberately absent from all application modules.
 * GET snapshots cannot invoke holds, recovery, execution or provider access.
 */
@Controller("scheduling/calendar-review")
@UseGuards(RequestAuthGuard, TenantGuard, CalendarReviewAccessGuard)
@UseFilters(CalendarReviewHttpFilter)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class CalendarReviewController {
  constructor(private readonly review: CalendarReviewStateService) {}

  @Get("jobs/:jobId/operations")
  @Header("Cache-Control", "private, no-store")
  listForJob(
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
    @Query() query: Record<string, unknown>,
  ) {
    this.requireEmptyQuery(query);
    return this.review.listForJob({ jobId });
  }

  @Get("operations/:operationId")
  @Header("Cache-Control", "private, no-store")
  read(
    @Param("operationId", new ParseUUIDPipe()) operationId: string,
    @Query() query: Record<string, unknown>,
  ) {
    this.requireEmptyQuery(query);
    return this.review.read({ operationId });
  }

  @Get("operations/:operationId/recovery-requests")
  @Header("Cache-Control", "private, no-store")
  listRecoveryRequests(
    @Param("operationId", new ParseUUIDPipe()) operationId: string,
    @Query() query: Record<string, unknown>,
  ) {
    this.requireEmptyQuery(query);
    return this.review.listRecoveryRequests({ operationId });
  }

  private requireEmptyQuery(query: Record<string, unknown>) {
    if (Object.keys(query).length) {
      throw new BadRequestException(
        "Calendar review does not accept query parameters.",
      );
    }
  }
}
