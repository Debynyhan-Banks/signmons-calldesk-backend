export const SMS_KEYS = [
  "APPOINTMENT_CONFIRMED",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_CANCELLED",
  "TECHNICIAN_ON_THE_WAY",
] as const;
export type SmsKey = (typeof SMS_KEYS)[number];
export type SmsPreferences = Record<SmsKey, boolean>;
export type MessagingSettings = {
  updatedAt: string;
  source: "legacy" | "default" | "saved" | "invalid";
  templates: {
    key: SmsKey;
    enabled: boolean;
    body: string;
    templateVersion: number;
  }[];
};
export function parseMessagingSettings(value: unknown): MessagingSettings {
  const item = value as MessagingSettings;
  if (
    !item ||
    typeof item.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(item.updatedAt)) ||
    new Date(item.updatedAt).toISOString() !== item.updatedAt ||
    !["legacy", "saved", "invalid"].includes(item.source) ||
    !Array.isArray(item.templates) ||
    item.templates.length !== 4 ||
    new Set(item.templates.map((template) => template?.key)).size !== 4 ||
    !item.templates.every(
      (t) =>
        t &&
        SMS_KEYS.includes(t.key) &&
        typeof t.enabled === "boolean" &&
        typeof t.body === "string" &&
        t.body.length > 0 &&
        t.body.length <= 1600 &&
        t.templateVersion === 1,
    )
  )
    throw new Error("Settings unavailable");
  return {
    updatedAt: item.updatedAt,
    source: item.source,
    templates: item.templates.map(
      ({ key, enabled, body, templateVersion }) => ({
        key,
        enabled,
        body,
        templateVersion,
      }),
    ),
  };
}
export function settingsError(status?: number, saving = false) {
  if (status === 401 || status === 403)
    return "Owner or admin access is required. Start a new authorized session.";
  if (status === 409)
    return "Settings changed or need review. Reload before saving again.";
  if (status === 400)
    return "Settings were rejected. Reload and review all preferences for this channel.";
  return saving
    ? "Save outcome is unconfirmed. Reload settings before saving again; do not assume it failed."
    : "Settings unavailable. Reload to try again.";
}
export class MessagingSettingsError extends Error {
  status: number;
  constructor(status: number) {
    super("Settings request failed");
    this.status = status;
  }
}
const apiOrigin =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ??
  "http://localhost:3000";
export async function requestMessagingSettings(
  token: string,
  signal: AbortSignal,
  input?: { expectedUpdatedAt: string; events: SmsPreferences },
  channel: "sms" | "email" = "sms",
) {
  const response = await fetch(
    apiOrigin +
      (channel === "email"
        ? "/communications/customer-email-settings"
        : "/communications/customer-messaging-settings"),
    {
      method: input ? "PUT" : "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: "application/json",
        ...(input ? { "Content-Type": "application/json" } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    },
  );
  if (response.status !== 200)
    throw new MessagingSettingsError(response.status);
  if (
    !response.headers
      .get("cache-control")
      ?.split(",")
      .some((v) => v.trim().toLowerCase() === "no-store") ||
    !response.headers.get("content-type")?.startsWith("application/json")
  )
    throw new Error("Settings unavailable");
  return channel === "email"
    ? parseEmailSettings(await response.json())
    : parseMessagingSettings(await response.json());
}

export function parseEmailSettings(value: unknown): MessagingSettings {
  const item = value as {
    updatedAt: string;
    source: "default" | "saved" | "invalid";
    events: Record<string, boolean>;
    recipientRole: string;
    deliveryAvailable: boolean;
  };
  const keys = SMS_KEYS.slice(0, 3);
  if (
    !item ||
    typeof item.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(item.updatedAt)) ||
    new Date(item.updatedAt).toISOString() !== item.updatedAt ||
    !["default", "saved", "invalid"].includes(item.source) ||
    item.recipientRole !== "customer" ||
    item.deliveryAvailable !== false ||
    !item.events ||
    Array.isArray(item.events) ||
    Object.keys(item.events).length !== 3 ||
    !keys.every(
      (key) =>
        Object.hasOwn(item.events, key) &&
        typeof item.events[key] === "boolean",
    ) ||
    (item.source !== "saved" && keys.some((key) => item.events[key]))
  )
    throw new Error("Email settings unavailable");
  return {
    updatedAt: item.updatedAt,
    source: item.source,
    templates: keys.map((key) => ({
      key,
      enabled: item.events[key],
      templateVersion: 1,
      body: "Event preference only — this is not an email preview. Customer email delivery is unavailable. Saving does not send or replay a message.",
    })),
  };
}
