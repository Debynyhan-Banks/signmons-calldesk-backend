import {
  Body,
  Controller,
  Get,
  Header,
  Put,
  UseGuards,
  UseFilters,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { IsISO8601, IsObject, Matches } from "class-validator";
import { RequestAuthGuard } from "../auth/request-auth.guard";
import { TenantGuard } from "../common/guards/tenant.guard";
import { CustomerMessagingSettingsService } from "./customer-messaging-settings.service";
import { CustomerMessagingSettingsFilter } from "./customer-messaging-settings.filter";

export class SaveCustomerMessagingSettingsDto {
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  expectedUpdatedAt!: string;
  @IsObject()
  events!: Record<string, boolean>;
}
@Controller("communications/customer-messaging-settings")
@UseGuards(RequestAuthGuard, TenantGuard)
@UseFilters(CustomerMessagingSettingsFilter)
export class CustomerMessagingSettingsController {
  constructor(private readonly settings: CustomerMessagingSettingsService) {}
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
