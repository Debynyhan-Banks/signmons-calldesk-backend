import * as Joi from "joi";

export const envValidationSchema = Joi.object({
  BACKGROUND_WORKERS_ENABLED: Joi.string()
    .valid("true", "false")
    .default("true"),
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
  TWILIO_WEBHOOK_BASE_URL: Joi.string().allow("").default(""),
  TWILIO_WEBHOOK_ENVIRONMENT: Joi.string()
    .valid("test", "staging", "production")
    .default("test"),
  TWILIO_TENANT_IDENTITIES_JSON: Joi.string().default("[]"),
  SMS_CONSENT_HASH_KEY: Joi.string().allow("").default(""),
  SMS_DELIVERY_ENABLED: Joi.string()
    .valid("true", "false", "TRUE", "FALSE")
    .default("false"),
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
  TECHNICIAN_LINK_SECRET: Joi.when("NODE_ENV", {
    is: "production",
    then: Joi.string().min(32).required(),
    otherwise: Joi.string()
      .min(32)
      .default("development-technician-link-secret-32-bytes"),
  }),
  TECHNICIAN_LINK_TTL_HOURS: Joi.number().min(1).max(168).default(72),
  TECHNICIAN_APP_BASE_URL: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .default("http://localhost:3101/app/technician"),
  STRIPE_SECRET_KEY: Joi.string().allow("").default(""),
  STRIPE_WEBHOOK_SECRET: Joi.string().allow("").default(""),
  STRIPE_WEBHOOK_LIVEMODE: Joi.string().valid("true", "false", "TRUE", "FALSE"),
  CUSTOMER_PAYMENT_RETURN_URL: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .default("http://localhost:3101/payment/status"),
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
  const twilioIdentities = parseTwilioIdentities(
    values.TWILIO_TENANT_IDENTITIES_JSON,
  );
  if (!twilioIdentities) return helpers.error("any.invalid");
  if (
    String(values.SMS_DELIVERY_ENABLED).toLowerCase() === "true" &&
    (twilioIdentities.length === 0 ||
      !hasConfiguredString(values.TWILIO_ACCOUNT_SID))
  ) {
    return helpers.error("any.invalid");
  }
  if (
    notificationEmails.length > 0 &&
    (!hasConfiguredString(values.RESEND_API_KEY) ||
      !hasConfiguredString(values.RESEND_FROM_EMAIL))
  ) {
    return helpers.error("any.invalid");
  }
  if (twilioIdentities.length > 0) {
    if (
      !hasConfiguredString(values.TWILIO_AUTH_TOKEN) ||
      !hasConfiguredString(values.TWILIO_WEBHOOK_BASE_URL) ||
      !hasConfiguredString(values.SMS_CONSENT_HASH_KEY) ||
      String(values.SMS_CONSENT_HASH_KEY).length < 32
    ) {
      return helpers.error("any.invalid");
    }
    let webhookBaseUrl: URL;
    try {
      webhookBaseUrl = new URL(String(values.TWILIO_WEBHOOK_BASE_URL));
    } catch {
      return helpers.error("any.invalid");
    }
    if (
      values.NODE_ENV === "production" &&
      webhookBaseUrl.protocol !== "https:"
    ) {
      return helpers.error("any.invalid");
    }
    if (
      webhookBaseUrl.pathname !== "/" ||
      webhookBaseUrl.search ||
      webhookBaseUrl.hash
    ) {
      return helpers.error("any.invalid");
    }
    const enabledKeys = new Set<string>();
    for (const identity of twilioIdentities) {
      if (!identity.enabled) continue;
      const key = `${identity.environment}:${identity.phoneNumber}`;
      if (enabledKeys.has(key)) return helpers.error("any.invalid");
      enabledKeys.add(key);
    }
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
  if (
    values.NODE_ENV === "production" &&
    hasConfiguredString(values.STRIPE_SECRET_KEY)
  ) {
    if (!hasConfiguredString(values.STRIPE_WEBHOOK_SECRET)) {
      return helpers.error("any.invalid");
    }
    const returnUrl = new URL(String(values.CUSTOMER_PAYMENT_RETURN_URL));
    if (
      returnUrl.protocol !== "https:" ||
      ["localhost", "127.0.0.1", "::1"].includes(returnUrl.hostname)
    ) {
      return helpers.error("any.invalid");
    }
  }
  if (
    values.NODE_ENV === "production" &&
    (hasConfiguredString(values.STRIPE_SECRET_KEY) ||
      hasConfiguredString(values.STRIPE_WEBHOOK_SECRET)) &&
    !hasConfiguredString(values.STRIPE_WEBHOOK_LIVEMODE)
  ) {
    return helpers.error("any.invalid");
  }
  if (
    values.NODE_ENV === "production" &&
    hasConfiguredString(values.STRIPE_SECRET_KEY)
  ) {
    const stripeKey = String(values.STRIPE_SECRET_KEY);
    const expectsLiveEvents =
      String(values.STRIPE_WEBHOOK_LIVEMODE).toLowerCase() === "true";
    if (
      ((stripeKey.startsWith("sk_live_") || stripeKey.startsWith("rk_live_")) &&
        !expectsLiveEvents) ||
      ((stripeKey.startsWith("sk_test_") || stripeKey.startsWith("rk_test_")) &&
        expectsLiveEvents)
    ) {
      return helpers.error("any.invalid");
    }
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

function parseTwilioIdentities(value: unknown): Array<{
  tenantId: string;
  phoneNumber: string;
  environment: string;
  enabled: boolean;
  timeZone: string;
  outboundQuietHoursStart: number;
  outboundQuietHoursEnd: number;
}> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const identities = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      const outboundQuietHoursStart =
        entry.outboundQuietHoursStart ?? entry.quietHoursStart;
      const outboundQuietHoursEnd =
        entry.outboundQuietHoursEnd ?? entry.quietHoursEnd;
      if (
        typeof entry.tenantId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          entry.tenantId,
        ) ||
        typeof entry.phoneNumber !== "string" ||
        !/^\+[1-9]\d{7,14}$/.test(entry.phoneNumber) ||
        !["test", "staging", "production"].includes(
          String(entry.environment),
        ) ||
        typeof entry.enabled !== "boolean" ||
        typeof entry.displayName !== "string" ||
        !entry.displayName.trim() ||
        typeof entry.voiceGreeting !== "string" ||
        !entry.voiceGreeting.trim() ||
        typeof entry.timeZone !== "string" ||
        !isTimeZone(entry.timeZone) ||
        typeof outboundQuietHoursStart !== "number" ||
        !Number.isInteger(outboundQuietHoursStart) ||
        outboundQuietHoursStart < 0 ||
        outboundQuietHoursStart > 23 ||
        typeof outboundQuietHoursEnd !== "number" ||
        !Number.isInteger(outboundQuietHoursEnd) ||
        outboundQuietHoursEnd < 0 ||
        outboundQuietHoursEnd > 23 ||
        typeof entry.supportPhone !== "string" ||
        !/^\+[1-9]\d{7,14}$/.test(entry.supportPhone)
      ) {
        return null;
      }
      identities.push({
        tenantId: entry.tenantId,
        phoneNumber: entry.phoneNumber,
        environment: String(entry.environment),
        enabled: entry.enabled,
        timeZone: entry.timeZone,
        outboundQuietHoursStart,
        outboundQuietHoursEnd,
      });
    }
    return identities;
  } catch {
    return null;
  }
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
