import {
  Body,
  Controller,
  Header,
  Post,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { RequestAuthGuard } from "../auth/request-auth.guard";
import { TenantGuard } from "../common/guards/tenant.guard";
import { CustomerMessagingSettingsFilter } from "../communications/customer-messaging-settings.filter";
import { JobPaymentPolicyService } from "./job-payment-policy.service";
/** Local-only; never production registered. */
@Controller("job-payment-policy")
@UseGuards(RequestAuthGuard, TenantGuard)
@UseFilters(CustomerMessagingSettingsFilter)
export class JobPaymentPolicyController {
  constructor(private readonly service: JobPaymentPolicyService) {}
  @Post("apply") @Header("Cache-Control", "private, no-store") apply(
    @Body() body: unknown,
  ) {
    return this.service.apply(body);
  }
}
