import { Module } from "@nestjs/common";
import { JOB_REPOSITORY } from "./jobs.constants";
import { JobsService } from "./jobs.service";
import { JobsToolRegistrar } from "./tools/jobs-tool.registrar";
import { JobNotificationService } from "./job-notification.service";

@Module({
  providers: [
    JobsService,
    JobNotificationService,
    {
      provide: JOB_REPOSITORY,
      useExisting: JobsService,
    },
    JobsToolRegistrar,
  ],
  exports: [JOB_REPOSITORY, JobsService],
})
export class JobsModule {}
