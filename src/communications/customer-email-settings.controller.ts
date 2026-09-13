import {
  Body,
  Controller,
  Get,
  Header,
  Put,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { RequestAuthGuard } from "../auth/request-auth.guard";
import { TenantGuard } from "../common/guards/tenant.guard";
import { SaveCustomerMessagingSettingsDto } from "./customer-messaging-settings.controller";
import { CustomerMessagingSettingsFilter } from "./customer-messaging-settings.filter";
import { CustomerEmailSettingsService } from "./customer-email-settings.service";
@Controller("communications/customer-email-settings")
@UseGuards(RequestAuthGuard, TenantGuard)
@UseFilters(CustomerMessagingSettingsFilter)
export class CustomerEmailSettingsController {
  constructor(private readonly settings: CustomerEmailSettingsService) {}
  @Get()
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  read() {
    return this.settings.read();
  }
  @Put()
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  save(@Body() body: SaveCustomerMessagingSettingsDto) {
    return this.settings.save(body);
  }
}
