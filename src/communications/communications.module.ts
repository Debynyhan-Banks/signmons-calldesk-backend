import { Module } from "@nestjs/common";
import { CustomerEmailSettingsController } from "./customer-email-settings.controller";
import { CustomerEmailSettingsService } from "./customer-email-settings.service";
import { CustomerMessagingSettingsController } from "./customer-messaging-settings.controller";
import { CustomerMessagingSettingsService } from "./customer-messaging-settings.service";
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
import { SmsEnqueueIntentService } from "./sms-enqueue-intent.service";
import { SmsEnqueueRecoveryService } from "./sms-enqueue-recovery.service";

@Module({
  imports: [AuthModule],
  controllers: [
    CustomerEmailSettingsController,
    TwilioWebhooksController,
    CommunicationsOperationsController,
    CustomerMessagingSettingsController,
  ],
  providers: [
    CustomerEmailSettingsService,
    CustomerMessagingSettingsService,
    TwilioWebhookService,
    SmsConsentService,
    SmsDeliveryService,
    SmsDeliveryWorker,
    CommunicationsOperationsAccessGuard,
    CommunicationsReplayAccessGuard,
    TransactionalMessageTemplateService,
    TransactionalMessagingService,
    SmsEnqueueIntentService,
    SmsEnqueueRecoveryService,
    TenantGuard,
    TwilioSmsProvider,
    { provide: SMS_PROVIDER, useExisting: TwilioSmsProvider },
  ],
  exports: [
    TwilioWebhookService,
    SmsConsentService,
    SmsDeliveryService,
    TransactionalMessagingService,
    SmsEnqueueIntentService,
  ],
})
export class CommunicationsModule {}
