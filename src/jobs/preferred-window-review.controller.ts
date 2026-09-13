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
import { PreferredWindowReviewService } from "./preferred-window-review.service";
/** Local composition only; no production module registration. */
@Controller("preferred-window-review")
@UseGuards(RequestAuthGuard, TenantGuard)
@UseFilters(CustomerMessagingSettingsFilter)
export class PreferredWindowReviewController {
  constructor(private readonly service: PreferredWindowReviewService) {}
  @Post("save") @Header("Cache-Control", "private, no-store") save(
    @Body() body: unknown,
  ) {
    return this.service.save(body);
  }
}
