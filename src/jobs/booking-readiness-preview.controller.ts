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
import { BookingReadinessPreviewService } from "./booking-readiness-preview.service";
/** Local fixture composition only; absent from production modules. */
@Controller("booking-readiness")
@UseGuards(RequestAuthGuard, TenantGuard)
@UseFilters(CustomerMessagingSettingsFilter)
export class BookingReadinessPreviewController {
  constructor(private readonly service: BookingReadinessPreviewService) {}
  @Post("preview")
  @Header("Cache-Control", "private, no-store")
  read(@Body() input: { jobId: string }) {
    return this.service.read(input);
  }
}
