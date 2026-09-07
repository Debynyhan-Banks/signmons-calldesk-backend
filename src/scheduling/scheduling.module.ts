import { Module } from "@nestjs/common";
import { JobsModule } from "../jobs/jobs.module";
import { PaymentsModule } from "../payments/payments.module";
import { AppointmentController } from "./appointment.controller";
import { SchedulingService } from "./scheduling.service";

@Module({
  imports: [JobsModule, PaymentsModule],
  controllers: [AppointmentController],
  providers: [SchedulingService],
  exports: [SchedulingService],
})
export class SchedulingModule {}
