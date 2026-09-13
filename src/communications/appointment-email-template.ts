import { createHash } from "node:crypto";

export type AppointmentEmailKind = "confirmed" | "rescheduled" | "cancelled";

/** Internal canonical snapshot, not a DTO or proof of current database/provider truth. */
export interface AppointmentEmailSnapshot {
  kind: AppointmentEmailKind;
  tenantId: string;
  jobId: string;
  brandName: string;
  supportPhone: string;
  serviceType: string;
  status: "CONFIRMED" | "CANCELLED";
  calendarOperationPending: false;
  calendarEventId: string | null;
  windowStart: string;
  windowEnd: string;
  updatedAt: string;
}

export interface AppointmentEmailActions {
  /** Server-approved origin; never take this policy from customer input. */
  allowedManagementOrigin: string;
  /** Already authorized elsewhere. This renderer never signs or verifies credentials. */
  managementUrl: string;
}

export interface AppointmentEmailContent {
  templateId: string;
  templateVersion: 1;
  subject: string;
  text: string;
  html: string;
}

export interface AppointmentEmail extends AppointmentEmailContent {
  sensitivity: "customer-private";
  calendar: { filename: string; contentType: string; content: string } | null;
}

const TITLES: Record<AppointmentEmailKind, string> = {
  confirmed: "Your appointment is confirmed",
  rescheduled: "Your appointment has been rescheduled",
  cancelled: "Your appointment has been cancelled",
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const PRIVATE_WARNING =
  "Keep your appointment link private. Anyone with the link may be able to view or change your appointment.";

export class AppointmentEmailInputError extends Error {
  constructor() {
    // Deliberately excludes input, links, tokens and provider diagnostics.
    super("Appointment email inputs are invalid or not eligible.");
    this.name = "AppointmentEmailInputError";
  }
}

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new AppointmentEmailInputError();
}

function safeText(value: unknown, max: number): string {
  requireValid(typeof value === "string");
  requireValid(
    value.length > 0 &&
      value.length <= max &&
      value.trim() === value &&
      !CONTROL.test(value),
  );
  return value;
}

function iso(value: unknown): Date {
  const text = safeText(value, 24);
  const date = new Date(text);
  requireValid(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) &&
      Number.isFinite(date.getTime()) &&
      date.toISOString() === text,
  );
  return date;
}

function validate(input: AppointmentEmailSnapshot) {
  requireValid(input && typeof input === "object");
  requireValid(
    typeof input.kind === "string" &&
      Object.prototype.hasOwnProperty.call(TITLES, input.kind),
  );
  const tenantId = safeText(input.tenantId, 36);
  const jobId = safeText(input.jobId, 36);
  requireValid(UUID.test(tenantId) && UUID.test(jobId));
  const brandName = safeText(input.brandName, 100);
  const serviceType = safeText(input.serviceType, 100);
  const supportPhone = safeText(input.supportPhone, 16);
  requireValid(/^\+[1-9]\d{7,14}$/.test(supportPhone));
  requireValid(input.calendarOperationPending === false);
  const cancelled = input.kind === "cancelled";
  requireValid(input.status === (cancelled ? "CANCELLED" : "CONFIRMED"));
  if (cancelled) requireValid(input.calendarEventId === null);
  else safeText(input.calendarEventId, 1024);
  const start = iso(input.windowStart);
  const end = iso(input.windowEnd);
  const updatedAt = iso(input.updatedAt);
  requireValid(end.getTime() > start.getTime());
  requireValid(
    [start, end].every(
      (date) => date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0,
    ),
  );
  // Explicit projection: ignore unrelated customer/provider/credential fields.
  return {
    kind: input.kind,
    tenantId,
    jobId,
    brandName,
    serviceType,
    supportPhone,
    cancelled,
    start,
    end,
    updatedAt,
  };
}

type Validated = ReturnType<typeof validate>;

function eastern(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

function managementUrl(actions: AppointmentEmailActions | undefined): string {
  requireValid(actions && typeof actions === "object");
  const origin = safeText(actions.allowedManagementOrigin, 255);
  const link = safeText(actions.managementUrl, 2400);
  let policy: URL;
  let url: URL;
  try {
    policy = new URL(origin);
    url = new URL(link);
  } catch {
    throw new AppointmentEmailInputError();
  }
  requireValid(policy.protocol === "https:" && policy.origin === origin);
  requireValid(
    url.origin === origin &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search,
  );
  requireValid(url.pathname === "/appointment/manage" && url.href === link);
  requireValid(/^#[A-Za-z0-9_.-]{20,2048}$/.test(url.hash));
  return link;
}

function render(
  input: Validated,
  action: { url: string } | "preview" | null,
): AppointmentEmailContent {
  const title = TITLES[input.kind];
  const window = `${eastern(input.start)} to ${eastern(input.end)} (Eastern Time)`;
  const rows = [
    ["Appointment reference", input.jobId.toUpperCase()],
    ["Service", input.serviceType],
    [
      input.cancelled ? "Previously scheduled window" : "Arrival window",
      window,
    ],
  ];
  const paragraphs = input.cancelled
    ? [
        "This appointment is cancelled. No visit is scheduled under this confirmation.",
        "Remove any saved calendar copy of this appointment. Contact us if you need another visit.",
      ]
    : [
        input.kind === "rescheduled"
          ? "The arrival window below replaces the previous appointment window."
          : "Your service appointment is confirmed for the arrival window below.",
        "The attached calendar file is a copy of this arrival window, not a live schedule. Import the latest copy after a change; your calendar app may require you to replace an older entry.",
        PRIVATE_WARNING,
      ];
  const fallback = `For help, call or text ${input.supportPhone}.`;
  const actionText =
    action === "preview"
      ? "Private management action omitted from operator preview. Calendar attachment omitted from operator preview."
      : action
        ? `Manage your appointment: ${action.url}\nAdd to calendar: open the attached appointment.ics file.`
        : "";
  const text = [
    input.brandName,
    title,
    ...paragraphs,
    ...rows.map(([label, value]) => `${label}: ${value}`),
    actionText,
    fallback,
  ]
    .filter(Boolean)
    .join("\n\n");
  const actionHtml =
    action === "preview"
      ? `<p>${escapeHtml(actionText)}</p>`
      : action
        ? `<p><a href="${escapeHtml(action.url)}" rel="noreferrer noopener" style="display:inline-block;padding:14px 18px;background:#123d4a;color:#fff;text-decoration:none;border-radius:6px">Manage appointment</a></p><p>Add to calendar: open the attached <strong>appointment.ics</strong> file.</p>`
        : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title></head><body style="margin:0;background:#f3f6f7;color:#17303b;font:16px/1.6 Arial,sans-serif"><table role="presentation" style="width:100%;border-collapse:collapse"><tr><td style="padding:20px 12px"><div style="max-width:600px;margin:auto;background:#fff;border:1px solid #dbe4e7;border-radius:10px;overflow-wrap:anywhere"><header style="padding:24px;background:#123d4a;color:#fff"><p style="margin:0">${escapeHtml(input.brandName)}</p><h1 style="font-size:26px;line-height:1.3;margin:10px 0 0">${escapeHtml(title)}</h1></header><main style="padding:24px">${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("")}<dl style="padding:16px;background:#f3f6f7">${rows.map(([label, value]) => `<dt style="font-weight:bold">${escapeHtml(label)}</dt><dd style="margin:0 0 14px">${escapeHtml(value)}</dd>`).join("")}</dl>${actionHtml}<p>${escapeHtml(fallback)}</p></main></div></td></tr></table></body></html>`;
  return {
    templateId: `appointment_email:${input.kind}:v1`,
    templateVersion: 1,
    subject: `${input.brandName}: ${title}`,
    text,
    html,
  };
}

function icalText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,");
}

function fold(line: string): string {
  let output = "",
    length = 0;
  for (const character of line) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (length + bytes > 75) {
      output += "\r\n ";
      length = 1;
    }
    output += character;
    length += bytes;
  }
  return output;
}

function calendar(input: Validated): NonNullable<AppointmentEmail["calendar"]> {
  const utc = (value: Date) =>
    value
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
  // Stable per tenant/job, no database ID or bearer action copied into the file.
  const uid = createHash("sha256")
    .update(`${input.tenantId.toLowerCase()}:${input.jobId.toLowerCase()}`)
    .digest("hex");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Signmons//Appointment Copy v1//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}@appointments.signmons`,
    `DTSTAMP:${utc(input.updatedAt)}`,
    `DTSTART:${utc(input.start)}`,
    `DTEND:${utc(input.end)}`,
    "CLASS:PRIVATE",
    "STATUS:CONFIRMED",
    `SUMMARY:${icalText(`${input.brandName}: ${input.serviceType}`)}`,
    "DESCRIPTION:Arrival window copy only. Consult your latest appointment message for changes.",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return {
    filename: "appointment.ics",
    contentType: "text/calendar; charset=utf-8",
    content: `${lines.map(fold).join("\r\n")}\r\n`,
  };
}

/** Customer-private output: never put this object in operator previews, analytics or logs. */
export function composeAppointmentEmail(
  input: AppointmentEmailSnapshot,
  actions?: AppointmentEmailActions,
): AppointmentEmail {
  const valid = validate(input);
  if (valid.cancelled) requireValid(actions === undefined);
  const action = valid.cancelled ? null : { url: managementUrl(actions) };
  return {
    ...render(valid, action),
    sensitivity: "customer-private",
    calendar: valid.cancelled ? null : calendar(valid),
  };
}

/** Accepts no action object and never renders a private link or calendar payload. */
export function previewAppointmentEmail(
  input: AppointmentEmailSnapshot,
): AppointmentEmailContent & { previewOnly: true } {
  const valid = validate(input);
  return {
    ...render(valid, valid.cancelled ? null : "preview"),
    previewOnly: true,
  };
}
