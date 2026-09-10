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
import { RequestAuthGuard } from "../auth/request-auth.guard";
import { TenantGuard } from "../common/guards/tenant.guard";
import { CustomerMessagingSettingsFilter } from "../communications/customer-messaging-settings.filter";
import { OrganizationPaymentPolicyService } from "./organization-payment-policy.service";
/** Local-only composition; no production registration. */
@Controller("organization/payment-policy")
@UseGuards(RequestAuthGuard, TenantGuard)
@UseFilters(CustomerMessagingSettingsFilter)
export class OrganizationPaymentPolicyController {
  constructor(private readonly service: OrganizationPaymentPolicyService) {}
  @Get() @Header("Cache-Control", "private, no-store") read() {
    return this.service.read();
  }
  @Put() @Header("Cache-Control", "private, no-store") save(
    @Body() body: unknown,
  ) {
    return this.service.write(body);
  }
  @Post("approve") @Header("Cache-Control", "private, no-store") approve(
    @Body() body: unknown,
  ) {
    return this.service.write(body, true);
  }
}
