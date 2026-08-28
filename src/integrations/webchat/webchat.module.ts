import { Module } from "@nestjs/common";
import { AiModule } from "../../ai/ai.module";
import { TenantGuard } from "../../common/guards/tenant.guard";
import { WebchatController } from "./webchat.controller";
import { WebchatIntegrationGuard } from "./webchat-integration.guard";

@Module({
  imports: [AiModule],
  controllers: [WebchatController],
  providers: [WebchatIntegrationGuard, TenantGuard],
})
export class WebchatModule {}
