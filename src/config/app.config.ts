import { registerAs } from "@nestjs/config";

export type NodeEnvironment = "development" | "production" | "test";

export interface AppConfig {
  environment: NodeEnvironment;
  openAiApiKey: string;
  enablePreviewModel: boolean;
  enabledTools: string[];
  aiMaxTokens: number;
  aiMaxToolCalls: number;
  aiTimeoutMs: number;
  aiMaxRetries: number;
  port: number;
  databaseUrl: string;
  adminApiToken: string;
  devAuthEnabled: boolean;
  devAuthSecret: string;
  identityIssuer: string;
  identityAudience: string;
  firebaseProjectId?: string;
  corsOrigins: string[];
  openAiModel: string;
  webchatIntegrations: WebchatIntegrationConfig[];
  resendApiKey: string;
  resendFromEmail: string;
  jobNotificationEmails: string[];
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  jobNotificationSmsNumbers: string[];
  conversationDataEncryptionKey: string;
  schedulingEnabled: boolean;
  googleCalendarId: string;
  schedulingTimeZone: string;
  schedulingLookaheadDays: number;
  schedulingMinNoticeMinutes: number;
}

export interface WebchatIntegrationConfig {
  name: string;
  tenantId: string;
  keyHash: string;
}

const DEFAULT_DATABASE_URL =
  "postgresql://signmons:Signmons-calldesk-backend-v1@localhost:5432/postgres?schema=calldesk";
const DEFAULT_CORS_ORIGINS = ["http://localhost:3000", "http://localhost:3101"];

export default registerAs("app", (): AppConfig => {
  const rawOrigins =
    process.env.FRONTEND_ORIGINS?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [];
  const corsOrigins = rawOrigins.length > 0 ? rawOrigins : DEFAULT_CORS_ORIGINS;
  const webchatIntegrations = parseWebchatIntegrations(
    process.env.WEBCHAT_INTEGRATIONS_JSON,
  );

  return {
    environment: (process.env.NODE_ENV as NodeEnvironment) ?? "development",
    openAiApiKey: process.env.OPENAI_API_KEY ?? "",
    enablePreviewModel:
      (process.env.ENABLE_GPT5_1_CODEX ?? "false").toLowerCase() === "true",
    enabledTools: (process.env.ENABLED_TOOLS ?? "create_job")
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean),
    aiMaxTokens: Number(process.env.AI_MAX_TOKENS ?? 800),
    aiMaxToolCalls: Number(process.env.AI_MAX_TOOL_CALLS ?? 1),
    aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 15000),
    aiMaxRetries: Number(process.env.AI_MAX_RETRIES ?? 1),
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    adminApiToken:
      process.env.ADMIN_API_TOKEN ?? "development-only-admin-token",
    devAuthEnabled:
      (process.env.DEV_AUTH_ENABLED ?? "false").toLowerCase() === "true",
    devAuthSecret: process.env.DEV_AUTH_SECRET ?? "dev-auth-secret",
    identityIssuer:
      process.env.IDENTITY_ISSUER ?? process.env.FIREBASE_ISSUER ?? "",
    identityAudience:
      process.env.IDENTITY_AUDIENCE ?? process.env.FIREBASE_AUDIENCE ?? "",
    firebaseProjectId:
      process.env.FIREBASE_ADMIN_PROJECT_ID ??
      process.env.FIREBASE_PROJECT_ID ??
      process.env.GOOGLE_CLOUD_PROJECT,
    corsOrigins,
    openAiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    webchatIntegrations,
    resendApiKey: process.env.RESEND_API_KEY ?? "",
    resendFromEmail: process.env.RESEND_FROM_EMAIL ?? "",
    jobNotificationEmails: parseCommaSeparated(
      process.env.JOB_NOTIFICATION_EMAILS,
    ),
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? "",
    twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER ?? "",
    jobNotificationSmsNumbers: parseCommaSeparated(
      process.env.JOB_NOTIFICATION_SMS_NUMBERS,
    ),
    conversationDataEncryptionKey:
      process.env.CONVERSATION_DATA_ENCRYPTION_KEY ?? "0".repeat(64),
    schedulingEnabled:
      (process.env.SCHEDULING_ENABLED ?? "false").toLowerCase() === "true",
    googleCalendarId: process.env.GOOGLE_CALENDAR_ID ?? "",
    schedulingTimeZone: process.env.SCHEDULING_TIME_ZONE ?? "America/New_York",
    schedulingLookaheadDays: Number(
      process.env.SCHEDULING_LOOKAHEAD_DAYS ?? 14,
    ),
    schedulingMinNoticeMinutes: Number(
      process.env.SCHEDULING_MIN_NOTICE_MINUTES ?? 120,
    ),
  };
});

function parseCommaSeparated(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function parseWebchatIntegrations(
  value: string | undefined,
): WebchatIntegrationConfig[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isWebchatIntegrationConfig);
}

function isWebchatIntegrationConfig(
  value: unknown,
): value is WebchatIntegrationConfig {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === "string" &&
    typeof entry.tenantId === "string" &&
    typeof entry.keyHash === "string"
  );
}
