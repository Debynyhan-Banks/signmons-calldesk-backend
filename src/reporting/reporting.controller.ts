import {
  Controller,
  Get,
  Header,
  Query,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { RequestAuthGuard } from "../auth/request-auth.guard";
import { getRequestContext } from "../common/context/request-context";
import { TenantGuard } from "../common/guards/tenant.guard";
import { LeadSourceReportQueryDto } from "./dto/lead-source-report-query.dto";
import { ReportingAccessGuard } from "./reporting-access.guard";
import { ReportingService } from "./reporting.service";

@Controller("reports")
@UseGuards(RequestAuthGuard, TenantGuard, ReportingAccessGuard)
export class ReportingController {
  constructor(private readonly reportingService: ReportingService) {}

  @Get("lead-sources")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 30, ttl: 60 } })
  getLeadSources(@Query() query: LeadSourceReportQueryDto) {
    const tenantId = getRequestContext()?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException("Tenant context is missing.");
    }
    return this.reportingService.getLeadSourceReport(tenantId, query);
  }
}
