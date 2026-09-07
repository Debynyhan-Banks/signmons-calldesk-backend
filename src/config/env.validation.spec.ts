import { envValidationSchema } from "./env.validation";

describe("environment validation", () => {
  const productionEnvironment = {
    NODE_ENV: "production",
    OPENAI_API_KEY: "production-openai-key",
    DATABASE_URL:
      "postgresql://service:password@database.internal:5432/signmons?schema=public",
    ADMIN_API_TOKEN: "a-production-admin-token-that-is-long",
    DEV_AUTH_ENABLED: "false",
    FIREBASE_PROJECT_ID: "signmons-production",
    WEBCHAT_INTEGRATIONS_JSON: JSON.stringify([
      {
        name: "eternity",
        tenantId: "8cf1e75e-14e7-4d4f-afd1-b4416a832ba1",
        keyHash: "a".repeat(64),
      },
    ]),
    RESEND_API_KEY: "resend-production-key",
    RESEND_FROM_EMAIL: "Eternity <requests@mail.eternityhvacr.com>",
    JOB_NOTIFICATION_EMAILS: "ben@eternityhvacr.com",
    CONVERSATION_DATA_ENCRYPTION_KEY: "b".repeat(64),
    TECHNICIAN_LINK_SECRET: "c".repeat(64),
  };

  it("accepts a production-safe configuration", () => {
    const result = envValidationSchema.validate(productionEnvironment);
    expect(result.error).toBeUndefined();
  });

  it.each([
    ["development authentication", { DEV_AUTH_ENABLED: "true" }],
    [
      "a local database",
      { DATABASE_URL: "postgresql://u:p@localhost:5432/db" },
    ],
    ["a short admin token", { ADMIN_API_TOKEN: "too-short-token" }],
  ])("rejects %s in production", (_label, override) => {
    const result = envValidationSchema.validate({
      ...productionEnvironment,
      ...override,
    });
    expect(result.error).toBeDefined();
  });

  it("rejects malformed webchat integration configuration", () => {
    const result = envValidationSchema.validate({
      ...productionEnvironment,
      WEBCHAT_INTEGRATIONS_JSON: JSON.stringify([
        { name: "eternity", tenantId: "attacker-controlled", keyHash: "bad" },
      ]),
    });
    expect(result.error).toBeDefined();
  });

  it("rejects a live create-job integration without an internal recipient", () => {
    const result = envValidationSchema.validate({
      ...productionEnvironment,
      JOB_NOTIFICATION_EMAILS: "",
    });
    expect(result.error).toBeDefined();
  });

  it("rejects an email recipient without Resend credentials", () => {
    const result = envValidationSchema.validate({
      ...productionEnvironment,
      RESEND_API_KEY: "",
    });
    expect(result.error).toBeDefined();
  });

  it("accepts a unique HTTPS Twilio tenant identity", () => {
    const result = envValidationSchema.validate({
      ...productionEnvironment,
      TWILIO_AUTH_TOKEN: "test-only-auth-token",
      SMS_CONSENT_HASH_KEY: "x".repeat(32),
      TWILIO_WEBHOOK_BASE_URL: "https://api.example.test",
      TWILIO_WEBHOOK_ENVIRONMENT: "staging",
      TWILIO_TENANT_IDENTITIES_JSON: JSON.stringify([
        {
          tenantId: "8cf1e75e-14e7-4d4f-afd1-b4416a832ba1",
          phoneNumber: "+13305550123",
          environment: "staging",
          enabled: true,
          displayName: "Example Contractor",
          voiceGreeting: "Thank you for calling Example Contractor.",
          timeZone: "America/New_York",
          quietHoursStart: 19,
          quietHoursEnd: 7,
          supportPhone: "+12165550199",
        },
      ]),
    });

    expect(result.error).toBeUndefined();
  });

  it("rejects enabled SMS delivery without an account and tenant identity", () => {
    const result = envValidationSchema.validate({
      ...productionEnvironment,
      SMS_DELIVERY_ENABLED: "true",
    });

    expect(result.error).toBeDefined();
  });

  it("rejects duplicate enabled Twilio identities in one environment", () => {
    const identity = {
      tenantId: "8cf1e75e-14e7-4d4f-afd1-b4416a832ba1",
      phoneNumber: "+13305550123",
      environment: "staging",
      enabled: true,
      displayName: "Example Contractor",
      voiceGreeting: "Thank you for calling Example Contractor.",
      timeZone: "America/New_York",
      quietHoursStart: 19,
      quietHoursEnd: 7,
      supportPhone: "+12165550199",
    };
    const result = envValidationSchema.validate({
      ...productionEnvironment,
      TWILIO_AUTH_TOKEN: "test-only-auth-token",
      SMS_CONSENT_HASH_KEY: "x".repeat(32),
      TWILIO_WEBHOOK_BASE_URL: "https://api.example.test",
      TWILIO_WEBHOOK_ENVIRONMENT: "staging",
      TWILIO_TENANT_IDENTITIES_JSON: JSON.stringify([
        identity,
        { ...identity, tenantId: "9a4ee1b2-807c-4caa-a176-4a5dd0a8eb10" },
      ]),
    });

    expect(result.error).toBeDefined();
  });

  it("rejects Twilio identities with malformed phone numbers", () => {
    const result = envValidationSchema.validate({
      ...productionEnvironment,
      TWILIO_AUTH_TOKEN: "test-only-auth-token",
      SMS_CONSENT_HASH_KEY: "x".repeat(32),
      TWILIO_WEBHOOK_BASE_URL: "https://api.example.test",
      TWILIO_TENANT_IDENTITIES_JSON: JSON.stringify([
        {
          tenantId: "8cf1e75e-14e7-4d4f-afd1-b4416a832ba1",
          phoneNumber: "330-555-0123",
          environment: "staging",
          enabled: true,
          displayName: "Example Contractor",
          voiceGreeting: "Thank you for calling Example Contractor.",
          timeZone: "America/New_York",
          quietHoursStart: 19,
          quietHoursEnd: 7,
          supportPhone: "+12165550199",
        },
      ]),
    });

    expect(result.error).toBeDefined();
  });

  it("rejects a Twilio webhook base URL containing a route", () => {
    const result = envValidationSchema.validate({
      ...productionEnvironment,
      TWILIO_AUTH_TOKEN: "test-only-auth-token",
      SMS_CONSENT_HASH_KEY: "x".repeat(32),
      TWILIO_WEBHOOK_BASE_URL: "https://api.example.test/untrusted-path",
      TWILIO_TENANT_IDENTITIES_JSON: JSON.stringify([
        {
          tenantId: "8cf1e75e-14e7-4d4f-afd1-b4416a832ba1",
          phoneNumber: "+13305550123",
          environment: "staging",
          enabled: true,
          displayName: "Example Contractor",
          voiceGreeting: "Thank you for calling Example Contractor.",
          timeZone: "America/New_York",
          quietHoursStart: 19,
          quietHoursEnd: 7,
          supportPhone: "+12165550199",
        },
      ]),
    });

    expect(result.error).toBeDefined();
  });

  it("rejects production without a conversation encryption key", () => {
    const withoutKey: Record<string, unknown> = { ...productionEnvironment };
    delete withoutKey.CONVERSATION_DATA_ENCRYPTION_KEY;
    const result = envValidationSchema.validate(withoutKey);
    expect(result.error).toBeDefined();
  });

  it("rejects production without a technician link signing secret", () => {
    const withoutKey: Record<string, unknown> = { ...productionEnvironment };
    delete withoutKey.TECHNICIAN_LINK_SECRET;
    const result = envValidationSchema.validate(withoutKey);
    expect(result.error).toBeDefined();
  });

  it("rejects a configured production checkout with a local return URL", () => {
    const result = envValidationSchema.validate({
      ...productionEnvironment,
      STRIPE_SECRET_KEY: "sk_live_not-a-real-secret",
      CUSTOMER_PAYMENT_RETURN_URL: "http://localhost:3101/payment/status",
    });
    expect(result.error).toBeDefined();
  });

  it("accepts a configured production checkout with an HTTPS return URL", () => {
    const result = envValidationSchema.validate({
      ...productionEnvironment,
      STRIPE_SECRET_KEY: "sk_live_not-a-real-secret",
      STRIPE_WEBHOOK_SECRET: "whsec_not-a-real-secret",
      STRIPE_WEBHOOK_LIVEMODE: "true",
      CUSTOMER_PAYMENT_RETURN_URL:
        "https://signmons-calldesk.web.app/payment/status",
    });
    expect(result.error).toBeUndefined();
  });

  it("rejects a configured production checkout without a webhook secret", () => {
    const result = envValidationSchema.validate({
      ...productionEnvironment,
      STRIPE_SECRET_KEY: "sk_live_not-a-real-secret",
      CUSTOMER_PAYMENT_RETURN_URL:
        "https://signmons-calldesk.web.app/payment/status",
    });
    expect(result.error).toBeDefined();
  });

  it("rejects configured production webhooks without an explicit event mode", () => {
    const result = envValidationSchema.validate({
      ...productionEnvironment,
      STRIPE_SECRET_KEY: "sk_live_not-a-real-secret",
      STRIPE_WEBHOOK_SECRET: "whsec_not-a-real-secret",
      CUSTOMER_PAYMENT_RETURN_URL:
        "https://signmons-calldesk.web.app/payment/status",
    });
    expect(result.error).toBeDefined();
  });

  it("rejects a Stripe key whose mode differs from the webhook mode", () => {
    const result = envValidationSchema.validate({
      ...productionEnvironment,
      STRIPE_SECRET_KEY: "rk_live_not-a-real-secret",
      STRIPE_WEBHOOK_SECRET: "whsec_not-a-real-secret",
      STRIPE_WEBHOOK_LIVEMODE: "false",
      CUSTOMER_PAYMENT_RETURN_URL:
        "https://signmons-calldesk.web.app/payment/status",
    });
    expect(result.error).toBeDefined();
  });
});
