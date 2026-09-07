import {
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import { getExpectedTwilioSignature } from "twilio";
import appConfig from "../config/app.config";
import type { SmsConsentService } from "./sms-consent.service";
import type { SmsDeliveryService } from "./sms-delivery.service";
import { TwilioWebhookService } from "./twilio-webhook.service";

describe("TwilioWebhookService", () => {
  const authToken = "test-only-twilio-auth-token";
  const baseUrl = "https://api.example.test";
  const destination = "+13305550123";
  const identity = {
    tenantId: "8cf1e75e-14e7-4d4f-afd1-b4416a832ba1",
    phoneNumber: destination,
    environment: "staging" as const,
    enabled: true,
    displayName: "Eternity Mechanical",
    voiceGreeting:
      "Thank you for calling Signmons on behalf of Eternity Mechanical. This call may be handled by an automated assistant. How may we help you today?",
    timeZone: "America/New_York",
    outboundQuietHoursStart: 21,
    outboundQuietHoursEnd: 8,
    supportPhone: "+12165550199",
  };

  it("returns tenant-specific TwiML after validating a voice webhook", () => {
    const service = createService();
    const body = {
      CallSid: "CA00000000000000000000000000000001",
      From: "+12165550183",
      To: destination,
    };

    const result = service.receiveVoice(body, signature("voice", body));

    expect(result).toContain("Thank you for calling Signmons");
    expect(result).toContain("automated assistant");
    expect(result).toMatch(/^<Response><Say>.*<\/Say><\/Response>$/);
  });

  it("keeps inbound voice available during outbound quiet hours", () => {
    const service = createService();
    const body = {
      CallSid: "CA00000000000000000000000000000002",
      From: "+12165550183",
      To: destination,
    };

    expect(service.receiveVoice(body, signature("voice", body))).toContain(
      "Thank you for calling Signmons",
    );
  });

  it("escapes configured voice greetings before emitting TwiML", () => {
    const service = createService({
      twilioTenantIdentities: [
        { ...identity, voiceGreeting: "Calls & service <support>" },
      ],
    });
    const body = { To: destination };

    expect(service.receiveVoice(body, signature("voice", body))).toContain(
      "Calls &amp; service &lt;support&gt;",
    );
  });

  it("rejects invalid signatures before destination resolution", () => {
    const service = createService();

    expect(() =>
      service.receiveVoice({ To: "+19999999999" }, "invalid-signature"),
    ).toThrow(UnauthorizedException);
  });

  it("fails closed for an unknown destination after signature validation", async () => {
    const service = createService();
    const body = { To: "+19999999999" };

    await expect(
      service.receiveSms(body, signature("sms", body)),
    ).rejects.toThrow(NotFoundException);
  });

  it("does not route an identity from a different environment", async () => {
    const service = createService({ twilioWebhookEnvironment: "production" });
    const body = { To: destination };

    await expect(
      service.receiveSms(body, signature("sms", body)),
    ).rejects.toThrow(NotFoundException);
  });

  it("returns empty TwiML for a valid inbound SMS without mutating workflow state", async () => {
    const service = createService();
    const body = {
      MessageSid: "SM00000000000000000000000000000001",
      From: "+12165550183",
      To: destination,
      Body: "Hello",
    };

    await expect(
      service.receiveSms(body, signature("sms", body)),
    ).resolves.toBe("<Response></Response>");
  });

  it("fails closed when webhook verification is not configured", async () => {
    const service = createService({ twilioAuthToken: "" });

    await expect(
      service.receiveSms({ To: destination }, "signature"),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it("validates and applies an outbound status callback", async () => {
    const delivery = { applyStatus: jest.fn().mockResolvedValue(undefined) };
    const service = createService({}, delivery);
    const body = {
      MessageSid: "SM00000000000000000000000000000001",
      MessageStatus: "delivered",
      From: destination,
      To: "+12165550183",
    };

    await service.receiveSmsStatus(body, signature("sms/status", body));

    expect(delivery.applyStatus).toHaveBeenCalledWith({
      tenantId: identity.tenantId,
      externalId: body.MessageSid,
      providerStatus: "delivered",
      errorCode: undefined,
    });
  });

  function createService(
    overrides: Partial<ConfigType<typeof appConfig>> = {},
    delivery = { applyStatus: jest.fn() },
  ): TwilioWebhookService {
    const consent = {
      handleInboundKeyword: jest.fn().mockResolvedValue(null),
    };
    return new TwilioWebhookService(
      {
        twilioAuthToken: authToken,
        twilioWebhookBaseUrl: baseUrl,
        twilioWebhookEnvironment: "staging",
        twilioTenantIdentities: [identity],
        smsConsentHashKey: "x".repeat(32),
        ...overrides,
      } as ConfigType<typeof appConfig>,
      consent as unknown as SmsConsentService,
      delivery as unknown as SmsDeliveryService,
    );
  }

  function signature(
    route: "voice" | "sms" | "sms/status",
    body: Record<string, string>,
  ): string {
    return getExpectedTwilioSignature(
      authToken,
      `${baseUrl}/webhooks/twilio/${route}`,
      body,
    );
  }
});
