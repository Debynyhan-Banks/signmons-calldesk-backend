import {
  Body,
  Controller,
  Post,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AiService } from "../../ai/ai.service";
import { TriageDto } from "../../ai/dto/triage.dto";
import { getRequestContext } from "../../common/context/request-context";
import { TenantGuard } from "../../common/guards/tenant.guard";
import { WebchatIntegrationGuard } from "./webchat-integration.guard";
import { ConfirmAppointmentDto } from "../../scheduling/dto/confirm-appointment.dto";
import { ManageAppointmentDto } from "../../scheduling/dto/manage-appointment.dto";
import { SchedulingService } from "../../scheduling/scheduling.service";

@Controller("api/integrations/webchat")
@UseGuards(WebchatIntegrationGuard, TenantGuard)
export class WebchatController {
  constructor(
    private readonly aiService: AiService,
    private readonly schedulingService: SchedulingService,
  ) {}

  @Post("triage")
  @Throttle({ default: { limit: 15, ttl: 60 } })
  triage(@Body() { sessionId, message, attribution }: TriageDto) {
    const tenantId = getRequestContext()?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException("Tenant context is missing.");
    }
    return this.aiService.triage(tenantId, sessionId, message, attribution);
  }

  @Post("appointments/confirm")
  @Throttle({ default: { limit: 10, ttl: 60 } })
  confirmAppointment(@Body() body: ConfirmAppointmentDto) {
    const tenantId = getRequestContext()?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException("Tenant context is missing.");
    }
    return this.schedulingService.confirmAppointment({ tenantId, ...body });
  }

  @Post("appointments/manage")
  @Throttle({ default: { limit: 20, ttl: 60 } })
  manageAppointment(@Body() body: ManageAppointmentDto) {
    const tenantId = getRequestContext()?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException("Tenant context is missing.");
    }
    return this.schedulingService.manageAppointment({ tenantId, ...body });
  }
}
