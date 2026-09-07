import { Module } from "@nestjs/common";
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

@Module({
  controllers: [TwilioWebhooksController, CommunicationsOperationsController],
  providers: [
    TwilioWebhookService,
    SmsConsentService,
    SmsDeliveryService,
    SmsDeliveryWorker,
    CommunicationsOperationsAccessGuard,
    CommunicationsReplayAccessGuard,
    TwilioSmsProvider,
    { provide: SMS_PROVIDER, useExisting: TwilioSmsProvider },
  ],
  exports: [TwilioWebhookService, SmsConsentService, SmsDeliveryService],
})
export class CommunicationsModule {}
