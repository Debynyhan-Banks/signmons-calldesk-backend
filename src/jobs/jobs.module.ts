import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { TenantGuard } from "../common/guards/tenant.guard";
import { JOB_REPOSITORY } from "./jobs.constants";
import { JobsService } from "./jobs.service";
import { JobsToolRegistrar } from "./tools/jobs-tool.registrar";
import { JobNotificationService } from "./job-notification.service";
import { JobLifecycleService } from "./job-lifecycle.service";
import { IntakeReadinessService } from "./intake-readiness.service";
import { IntakeReviewAccessGuard } from "./intake-review-access.guard";
import { JobOperationsAccessGuard } from "./job-operations-access.guard";
import { JobsController } from "./jobs.controller";
import { UrgencyReviewAccessGuard } from "./urgency-review-access.guard";
import { UrgencyReviewService } from "./urgency-review.service";
import { DispatchAccessGuard } from "./dispatch-access.guard";
import { DispatchBoardService } from "./dispatch-board.service";

@Module({
  imports: [AuthModule],
  controllers: [JobsController],
  providers: [
    JobsService,
    JobNotificationService,
    JobLifecycleService,
    IntakeReadinessService,
    IntakeReviewAccessGuard,
    JobOperationsAccessGuard,
    UrgencyReviewAccessGuard,
    UrgencyReviewService,
    DispatchAccessGuard,
    DispatchBoardService,
    TenantGuard,
    {
      provide: JOB_REPOSITORY,
      useExisting: JobsService,
    },
    JobsToolRegistrar,
  ],
  exports: [
    JOB_REPOSITORY,
    JobsService,
    JobNotificationService,
    JobLifecycleService,
    UrgencyReviewService,
    DispatchBoardService,
  ],
})
export class JobsModule {}
