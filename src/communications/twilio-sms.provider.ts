import { Inject, Injectable } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import appConfig from "../config/app.config";
import {
  SmsProviderError,
  type SmsProvider,
  type SmsProviderRequest,
  type SmsProviderResult,
} from "./sms-provider.interface";

@Injectable()
export class TwilioSmsProvider implements SmsProvider {
  constructor(
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  async send(request: SmsProviderRequest): Promise<SmsProviderResult> {
    if (!this.config.twilioAccountSid || !this.config.twilioAuthToken) {
      throw new SmsProviderError(
        "SMS provider is not configured.",
        "configuration",
        false,
      );
    }
    const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.twilioAccountSid)}/Messages.json`;
    const form = new URLSearchParams({
      From: request.from,
      To: request.to,
      Body: request.body,
      StatusCallback: request.statusCallback,
    });
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.config.twilioAccountSid}:${this.config.twilioAuthToken}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      // The provider may have accepted a timed-out request. Retrying could duplicate it.
      throw new SmsProviderError(
        "SMS provider outcome is unknown.",
        "ambiguous_transport",
        false,
      );
    }
    if (!response.ok) {
      throw new SmsProviderError(
        `SMS provider rejected the request with HTTP ${response.status}.`,
        `http_${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    const payload = (await response.json()) as {
      sid?: unknown;
      status?: unknown;
    };
    if (
      typeof payload.sid !== "string" ||
      !/^(SM|MM)[0-9a-f]{32}$/i.test(payload.sid)
    ) {
      throw new SmsProviderError(
        "SMS provider returned an invalid response.",
        "invalid_response",
        false,
      );
    }
    return {
      externalId: payload.sid,
      status: typeof payload.status === "string" ? payload.status : "queued",
    };
  }
}
