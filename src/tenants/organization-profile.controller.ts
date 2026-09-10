import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Put,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { RequestAuthGuard } from "../auth/request-auth.guard";
import { TenantGuard } from "../common/guards/tenant.guard";
import { CustomerMessagingSettingsFilter } from "../communications/customer-messaging-settings.filter";
import { OrganizationProfileService } from "./organization-profile.service";

@Controller("organization/profile")
@UseGuards(RequestAuthGuard, TenantGuard)
@UseFilters(CustomerMessagingSettingsFilter)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class OrganizationProfileController {
  constructor(private readonly service: OrganizationProfileService) {}
  @Get()
  @Header("Cache-Control", "private, no-store")
  read() {
    return this.service.read();
  }
  @Put()
  @Header("Cache-Control", "private, no-store")
  save(@Body() body: unknown) {
    return this.service.write(body);
  }
  @Post("approve")
  @Header("Cache-Control", "private, no-store")
  approve(@Body() body: unknown) {
    return this.service.write(body, true);
  }
  @Post("preview")
  @Header("Cache-Control", "private, no-store")
  preview(@Body() body: unknown) {
    return this.service.answer(body);
  }
}
