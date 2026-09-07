import { Body, Controller, Header, Headers, Post } from "@nestjs/common";
import { TwilioWebhookService } from "./twilio-webhook.service";

@Controller("webhooks/twilio")
export class TwilioWebhooksController {
  constructor(private readonly webhooks: TwilioWebhookService) {}

  @Post("voice")
  @Header("content-type", "text/xml")
  receiveVoice(
    @Body() body: Record<string, string>,
    @Headers("x-twilio-signature") signature: string | undefined,
  ): string {
    return this.webhooks.receiveVoice(body, signature);
  }

  @Post("sms")
  @Header("content-type", "text/xml")
  async receiveSms(
    @Body() body: Record<string, string>,
    @Headers("x-twilio-signature") signature: string | undefined,
  ): Promise<string> {
    return this.webhooks.receiveSms(body, signature);
  }

  @Post("sms/status")
  async receiveSmsStatus(
    @Body() body: Record<string, string>,
    @Headers("x-twilio-signature") signature: string | undefined,
  ): Promise<void> {
    await this.webhooks.receiveSmsStatus(body, signature);
  }
}
