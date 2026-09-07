import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import { validateRequest } from "twilio";
import appConfig, {
  type TwilioTenantIdentityConfig,
} from "../config/app.config";
import { SmsConsentService } from "./sms-consent.service";
import { SmsDeliveryService } from "./sms-delivery.service";

type TwilioForm = Record<string, string>;

@Injectable()
export class TwilioWebhookService {
  constructor(
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
    private readonly consent: SmsConsentService,
    private readonly delivery: SmsDeliveryService,
  ) {}

  receiveVoice(body: TwilioForm, signature: string | undefined): string {
    const identity = this.verifyAndResolve("voice", body, signature);
    return `<Response><Say>${escapeXml(identity.voiceGreeting)}</Say></Response>`;
  }

  async receiveSmsStatus(
    body: TwilioForm,
    signature: string | undefined,
  ): Promise<void> {
    const identity = this.verifyAndResolve(
      "sms/status",
      body,
      signature,
      "From",
    );
    await this.delivery.applyStatus({
      tenantId: identity.tenantId,
      externalId: body.MessageSid ?? "",
      providerStatus: body.MessageStatus ?? "",
      errorCode: body.ErrorCode,
    });
  }

  async receiveSms(
    body: TwilioForm,
    signature: string | undefined,
  ): Promise<string> {
    const identity = this.verifyAndResolve("sms", body, signature);
    const reply = await this.consent.handleInboundKeyword({
      tenantId: identity.tenantId,
      phoneNumber: body.From ?? "",
      body: body.Body ?? "",
      optOutType: body.OptOutType,
      displayName: identity.displayName,
      supportPhone: identity.supportPhone,
    });
    return reply
      ? `<Response><Message>${escapeXml(reply)}</Message></Response>`
      : "<Response></Response>";
  }

  private verifyAndResolve(
    route: "voice" | "sms" | "sms/status",
    body: TwilioForm,
    signature: string | undefined,
    destinationField: "To" | "From" = "To",
  ): TwilioTenantIdentityConfig {
    const requestUrl = this.requestUrl(route);
    if (!this.config.twilioAuthToken || !requestUrl) {
      throw new ServiceUnavailableException(
        "Twilio webhook processing is not configured.",
      );
    }
    if (
      !signature ||
      !validateRequest(this.config.twilioAuthToken, signature, requestUrl, body)
    ) {
      throw new UnauthorizedException("Twilio webhook signature is invalid.");
    }

    const destination = body[destinationField] ?? body.Called;
    const matches = this.config.twilioTenantIdentities.filter(
      (identity) =>
        identity.enabled &&
        identity.environment === this.config.twilioWebhookEnvironment &&
        identity.phoneNumber === destination,
    );
    if (matches.length !== 1) {
      throw new NotFoundException(
        "Communication destination is not configured.",
      );
    }
    return matches[0];
  }

  private requestUrl(route: "voice" | "sms" | "sms/status"): string {
    return this.config.twilioWebhookBaseUrl
      ? `${this.config.twilioWebhookBaseUrl.replace(/\/$/, "")}/webhooks/twilio/${route}`
      : "";
  }
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => {
    const entities: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entities[character];
  });
}
