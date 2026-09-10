import {
  Body,
  Controller,
  Header,
  Post,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { RequestAuthGuard } from "../auth/request-auth.guard";
import { TenantGuard } from "../common/guards/tenant.guard";
import { CustomerMessagingSettingsFilter } from "./customer-messaging-settings.filter";
import { CustomerIntakeContinuationService } from "./customer-intake-continuation.service";

/** Local composition only: deliberately absent from production modules. */
@Controller("intake-review-request")
@UseGuards(RequestAuthGuard, TenantGuard)
@UseFilters(CustomerMessagingSettingsFilter)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class CustomerIntakeReviewController {
  constructor(private readonly intake: CustomerIntakeContinuationService) {}
  @Post("read")
  @Header("Cache-Control", "private, no-store")
  read(@Body() input: { requestId: string }) {
    return this.intake.readReview(input);
  }
  @Post("approve")
  @Header("Cache-Control", "private, no-store")
  approve(
    @Body()
    input: {
      requestId: string;
      expectedOrganizationApprovedAt: string;
      review: unknown;
    },
  ) {
    return this.intake.admitReview(input);
  }
}
