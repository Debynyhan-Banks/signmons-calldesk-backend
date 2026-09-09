import { Controller, Get, Header, Headers, UseFilters } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { TechnicianNotificationsService } from "./technician-notifications.service";
import { TechnicianNotificationsFilter } from "./technician-notifications.filter";

@Controller("technician/notifications")
@UseFilters(TechnicianNotificationsFilter)
export class TechnicianNotificationsController {
  constructor(private readonly notifications: TechnicianNotificationsService) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  list(@Headers("x-technician-link") link: string | undefined) {
    return this.notifications.list(link);
  }
}
