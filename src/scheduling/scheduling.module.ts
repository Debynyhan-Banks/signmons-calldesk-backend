import { Module } from "@nestjs/common";
import { CommunicationsModule } from "../communications/communications.module";
import { JobsModule } from "../jobs/jobs.module";
import { PaymentsModule } from "../payments/payments.module";
import { AppointmentController } from "./appointment.controller";
import { AppointmentConfirmationService } from "./appointment-confirmation.service";
import { AppointmentCancellationService } from "./appointment-cancellation.service";
import { AppointmentReschedulingService } from "./appointment-rescheduling.service";
import { SchedulingService } from "./scheduling.service";

@Module({
  imports: [JobsModule, PaymentsModule, CommunicationsModule],
  controllers: [AppointmentController],
  providers: [
    SchedulingService,
    AppointmentConfirmationService,
    AppointmentCancellationService,
    AppointmentReschedulingService,
  ],
  exports: [SchedulingService],
})
export class SchedulingModule {}
