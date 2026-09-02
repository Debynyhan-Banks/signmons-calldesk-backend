import { Body, Controller, Header, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ManageAppointmentDto } from "./dto/manage-appointment.dto";
import { SchedulingService } from "./scheduling.service";

@Controller("appointments")
export class AppointmentController {
  constructor(private readonly schedulingService: SchedulingService) {}

  @Post("manage")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 20, ttl: 60 } })
  manageAppointment(@Body() body: ManageAppointmentDto) {
    return this.schedulingService.manageAppointment(body);
  }
}
