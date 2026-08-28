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

@Controller("api/integrations/webchat")
@UseGuards(WebchatIntegrationGuard, TenantGuard)
export class WebchatController {
  constructor(private readonly aiService: AiService) {}

  @Post("triage")
  @Throttle({ default: { limit: 15, ttl: 60 } })
  triage(@Body() { sessionId, message }: TriageDto) {
    const tenantId = getRequestContext()?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException("Tenant context is missing.");
    }
    return this.aiService.triage(tenantId, sessionId, message);
  }
}
