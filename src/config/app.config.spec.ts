import appConfig, { type AppConfig } from "./app.config";

describe("application configuration", () => {
  const originalIdentities = process.env.TWILIO_TENANT_IDENTITIES_JSON;

  afterEach(() => {
    if (originalIdentities === undefined) {
      delete process.env.TWILIO_TENANT_IDENTITIES_JSON;
    } else {
      process.env.TWILIO_TENANT_IDENTITIES_JSON = originalIdentities;
    }
  });

  it("normalizes legacy quiet-hour fields to outbound-only fields", () => {
    process.env.TWILIO_TENANT_IDENTITIES_JSON = JSON.stringify([
      {
        tenantId: "8cf1e75e-14e7-4d4f-afd1-b4416a832ba1",
        phoneNumber: "+13305550123",
        environment: "staging",
        enabled: true,
        displayName: "Example Contractor",
        voiceGreeting: "Thank you for calling Example Contractor.",
        timeZone: "America/New_York",
        quietHoursStart: 21,
        quietHoursEnd: 8,
        supportPhone: "+12165550199",
      },
    ]);

    const config = (appConfig as unknown as () => AppConfig)();

    expect(config.twilioTenantIdentities).toEqual([
      expect.objectContaining({
        outboundQuietHoursStart: 21,
        outboundQuietHoursEnd: 8,
      }),
    ]);
    expect(config.twilioTenantIdentities[0]).not.toHaveProperty(
      "quietHoursStart",
    );
  });
});
