import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { TenantGuard } from "../common/guards/tenant.guard";
import { TwilioWebhooksController } from "./twilio-webhooks.controller";
import { TwilioWebhookService } from "./twilio-webhook.service";
import { SmsConsentService } from "./sms-consent.service";
import { SmsDeliveryService } from "./sms-delivery.service";
import { SMS_PROVIDER } from "./sms-provider.interface";
import { TwilioSmsProvider } from "./twilio-sms.provider";
import { SmsDeliveryWorker } from "./sms-delivery.worker";
import { CommunicationsOperationsController } from "./communications-operations.controller";
import { CommunicationsOperationsAccessGuard } from "./communications-operations-access.guard";
import { CommunicationsReplayAccessGuard } from "./communications-replay-access.guard";
import { TransactionalMessageTemplateService } from "./transactional-message-template.service";
import { TransactionalMessagingService } from "./transactional-messaging.service";

@Module({
  imports: [AuthModule],
  controllers: [TwilioWebhooksController, CommunicationsOperationsController],
  providers: [
    TwilioWebhookService,
    SmsConsentService,
    SmsDeliveryService,
    SmsDeliveryWorker,
    CommunicationsOperationsAccessGuard,
    CommunicationsReplayAccessGuard,
    TransactionalMessageTemplateService,
    TransactionalMessagingService,
    TenantGuard,
    TwilioSmsProvider,
    { provide: SMS_PROVIDER, useExisting: TwilioSmsProvider },
  ],
  exports: [
    TwilioWebhookService,
    SmsConsentService,
    SmsDeliveryService,
    TransactionalMessagingService,
  ],
})
export class CommunicationsModule {}
