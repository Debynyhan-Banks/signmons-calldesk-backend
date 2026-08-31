import * as Joi from "joi";

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid("development", "production", "test")
    .default("development"),
  OPENAI_API_KEY: Joi.when("NODE_ENV", {
    is: "test",
    then: Joi.string().default("test-only-not-a-real-key"),
    otherwise: Joi.string().min(10).required(),
  }),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ["postgres", "postgresql"] })
    .default(
      "postgresql://signmons:Signmons-calldesk-backend-v1@localhost:5432/postgres?schema=calldesk",
    ),
  ADMIN_API_TOKEN: Joi.when("NODE_ENV", {
    is: "production",
    then: Joi.string().min(24).required(),
    otherwise: Joi.string().min(12).default("development-only-admin-token"),
  }),
  DEV_AUTH_ENABLED: Joi.string()
    .valid("true", "false", "TRUE", "FALSE")
    .default("false"),
  DEV_AUTH_SECRET: Joi.string().min(8).default("dev-auth-secret"),
  IDENTITY_ISSUER: Joi.string().allow("").default(""),
  IDENTITY_AUDIENCE: Joi.string().allow("").default(""),
  FIREBASE_ADMIN_PROJECT_ID: Joi.string().allow("").default(""),
  FIREBASE_PROJECT_ID: Joi.string().allow("").default(""),
  FIREBASE_ISSUER: Joi.string().allow("").default(""),
  FIREBASE_AUDIENCE: Joi.string().allow("").default(""),
  FRONTEND_ORIGINS: Joi.string().allow("").default(""),
  GOOGLE_APPLICATION_CREDENTIALS: Joi.string().allow("").default(""),
  ENABLE_GPT5_1_CODEX: Joi.string()
    .valid("true", "false", "TRUE", "FALSE")
    .default("false"),
  ENABLED_TOOLS: Joi.string().default("create_job"),
  AI_MAX_TOKENS: Joi.number().min(1).max(8000).default(800),
  AI_MAX_TOOL_CALLS: Joi.number().min(0).max(5).default(1),
  AI_TIMEOUT_MS: Joi.number().min(1000).max(60000).default(15000),
  AI_MAX_RETRIES: Joi.number().min(0).max(5).default(1),
  OPENAI_MODEL: Joi.string().min(3).max(100).default("gpt-4o-mini"),
  WEBCHAT_INTEGRATIONS_JSON: Joi.string().default("[]"),
  RESEND_API_KEY: Joi.string().allow("").default(""),
  RESEND_FROM_EMAIL: Joi.string().allow("").default(""),
  JOB_NOTIFICATION_EMAILS: Joi.string().allow("").default(""),
  TWILIO_ACCOUNT_SID: Joi.string().allow("").default(""),
  TWILIO_AUTH_TOKEN: Joi.string().allow("").default(""),
  TWILIO_PHONE_NUMBER: Joi.string().allow("").default(""),
  JOB_NOTIFICATION_SMS_NUMBERS: Joi.string().allow("").default(""),
  CONVERSATION_DATA_ENCRYPTION_KEY: Joi.when("NODE_ENV", {
    is: "production",
    then: Joi.string()
      .pattern(/^[0-9a-f]{64}$/i)
      .required(),
    otherwise: Joi.string()
      .pattern(/^[0-9a-f]{64}$/i)
      .default("0".repeat(64)),
  }),
  SCHEDULING_ENABLED: Joi.string()
    .valid("true", "false", "TRUE", "FALSE")
    .default("false"),
  GOOGLE_CALENDAR_ID: Joi.string().allow("").default(""),
  SCHEDULING_TIME_ZONE: Joi.string().default("America/New_York"),
  SCHEDULING_LOOKAHEAD_DAYS: Joi.number().min(1).max(45).default(14),
  SCHEDULING_MIN_NOTICE_MINUTES: Joi.number().min(0).max(10080).default(120),
  PORT: Joi.number().min(0).max(65535).default(3000),
}).custom((rawValues: unknown, helpers) => {
  const values = rawValues as Record<string, unknown>;
  if (
    values.NODE_ENV === "production" &&
    String(values.DEV_AUTH_ENABLED).toLowerCase() === "true"
  ) {
    return helpers.error("any.invalid", {
      message: "DEV_AUTH_ENABLED cannot be true in production.",
    });
  }
  const notificationEmails = parseConfiguredList(
    values.JOB_NOTIFICATION_EMAILS,
  );
  const notificationSmsNumbers = parseConfiguredList(
    values.JOB_NOTIFICATION_SMS_NUMBERS,
  );
  if (
    notificationEmails.length > 0 &&
    (!hasConfiguredString(values.RESEND_API_KEY) ||
      !hasConfiguredString(values.RESEND_FROM_EMAIL))
  ) {
    return helpers.error("any.invalid");
  }
  if (
    notificationSmsNumbers.length > 0 &&
    (!hasConfiguredString(values.TWILIO_ACCOUNT_SID) ||
      !hasConfiguredString(values.TWILIO_AUTH_TOKEN) ||
      !hasConfiguredString(values.TWILIO_PHONE_NUMBER))
  ) {
    return helpers.error("any.invalid");
  }
  try {
    const rawIntegrations = values.WEBCHAT_INTEGRATIONS_JSON;
    if (typeof rawIntegrations !== "string") {
      return helpers.error("any.invalid");
    }
    const integrations = JSON.parse(rawIntegrations) as unknown;
    if (!Array.isArray(integrations)) return helpers.error("any.invalid");
    for (const entry of integrations) {
      if (!entry || typeof entry !== "object")
        return helpers.error("any.invalid");
      const candidate = entry as Record<string, unknown>;
      if (
        typeof candidate.name !== "string" ||
        !candidate.name.trim() ||
        typeof candidate.tenantId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          candidate.tenantId,
        ) ||
        typeof candidate.keyHash !== "string" ||
        !/^[0-9a-f]{64}$/i.test(candidate.keyHash)
      ) {
        return helpers.error("any.invalid");
      }
    }
    if (
      values.NODE_ENV === "production" &&
      integrations.length > 0 &&
      String(values.ENABLED_TOOLS).split(",").includes("create_job") &&
      notificationEmails.length === 0 &&
      notificationSmsNumbers.length === 0
    ) {
      return helpers.error("any.invalid");
    }
  } catch {
    return helpers.error("any.invalid");
  }
  if (values.NODE_ENV === "production") {
    if (String(values.DATABASE_URL).includes("localhost")) {
      return helpers.error("any.invalid");
    }
    const firebaseProject =
      values.FIREBASE_ADMIN_PROJECT_ID ||
      values.FIREBASE_PROJECT_ID ||
      values.GOOGLE_CLOUD_PROJECT;
    if (!firebaseProject) return helpers.error("any.invalid");
  }
  if (
    String(values.SCHEDULING_ENABLED).toLowerCase() === "true" &&
    !hasConfiguredString(values.GOOGLE_CALENDAR_ID)
  ) {
    return helpers.error("any.invalid");
  }
  return values;
});

function parseConfiguredList(value: unknown): string[] {
  return typeof value === "string"
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function hasConfiguredString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
