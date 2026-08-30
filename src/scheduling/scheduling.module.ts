import { Module } from "@nestjs/common";
import { JobsModule } from "../jobs/jobs.module";
import { SchedulingService } from "./scheduling.service";

@Module({
  imports: [JobsModule],
  providers: [SchedulingService],
  exports: [SchedulingService],
})
export class SchedulingModule {}
