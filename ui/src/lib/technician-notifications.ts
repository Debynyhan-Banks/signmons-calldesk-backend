export const technicianNotificationLabels = {
  "job.assigned": "Job assigned",
  "job.reassigned": "Assignment changed",
  "job.urgency_escalated": "Urgency escalated",
  "appointment.initial_confirmed": "Appointment confirmation recorded",
  "appointment.customer_rescheduled": "Appointment reschedule recorded",
  "appointment.customer_cancelled": "Appointment cancellation recorded",
  "job.technician_accepted": "Technician acceptance recorded",
  "job.technician_en_route": "On-the-way status recorded",
  "job.technician_started": "Work started",
  "job.technician_completed": "Work completed",
} as const;
type Action = keyof typeof technicianNotificationLabels;
export type TechnicianNotificationSnapshot = {
  snapshot: true;
  asOf: string;
  lookbackDays: 90;
  limit: 100;
  hasMore: boolean;
  items: { id: string; jobId: string; action: Action; occurredAt: string }[];
};
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function canonicalDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
export function parseTechnicianNotifications(
  value: unknown,
): TechnicianNotificationSnapshot {
  const v = value as TechnicianNotificationSnapshot;
  if (
    !v ||
    v.snapshot !== true ||
    !canonicalDate(v.asOf) ||
    v.lookbackDays !== 90 ||
    v.limit !== 100 ||
    typeof v.hasMore !== "boolean" ||
    !Array.isArray(v.items) ||
    v.items.length > 100 ||
    (v.hasMore && v.items.length !== 100) ||
    new Set(v.items.map((i) => i?.id)).size !== v.items.length ||
    !v.items.every(
      (i) =>
        i &&
        typeof i.id === "string" &&
        uuid.test(i.id) &&
        typeof i.jobId === "string" &&
        uuid.test(i.jobId) &&
        Object.prototype.hasOwnProperty.call(
          technicianNotificationLabels,
          i.action,
        ) &&
        canonicalDate(i.occurredAt) &&
        i.occurredAt <= v.asOf &&
        Date.parse(i.occurredAt) >= Date.parse(v.asOf) - 90 * 86400000,
    )
  )
    throw new Error("Invalid notification snapshot");
  return {
    snapshot: true,
    asOf: v.asOf,
    lookbackDays: 90,
    limit: 100,
    hasMore: v.hasMore,
    items: v.items.map(({ id, jobId, action, occurredAt }) => ({
      id,
      jobId,
      action,
      occurredAt,
    })),
  };
}
export class TechnicianInboxError extends Error {
  status: number;
  constructor(status: number) {
    super("Notifications unavailable");
    this.status = status;
  }
}
const api =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ??
  "http://localhost:3000";
export async function readTechnicianNotifications(
  token: string,
  signal: AbortSignal,
) {
  const response = await fetch(api + "/technician/notifications", {
    method: "GET",
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal,
    headers: { Accept: "application/json", "x-technician-link": token },
  });
  if (response.status !== 200) throw new TechnicianInboxError(response.status);
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? "",
    ) ||
    !response.headers
      .get("cache-control")
      ?.split(",")
      .some((v) => v.trim().toLowerCase() === "no-store")
  )
    throw new Error("Invalid notification response");
  return parseTechnicianNotifications(await response.json());
}
