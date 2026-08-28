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
});
