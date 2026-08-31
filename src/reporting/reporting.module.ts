import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { TenantGuard } from "../common/guards/tenant.guard";
import { ReportingAccessGuard } from "./reporting-access.guard";
import { ReportingController } from "./reporting.controller";
import { ReportingService } from "./reporting.service";

@Module({
  imports: [AuthModule],
  controllers: [ReportingController],
  providers: [ReportingService, ReportingAccessGuard, TenantGuard],
  exports: [ReportingService],
})
export class ReportingModule {}
