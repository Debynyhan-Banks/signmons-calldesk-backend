import type { SmsHistoryItem } from "./api";

export type HistoryFilter = "all" | "attention" | "pending" | "delivered";

export function filterHistory(items: SmsHistoryItem[], filter: HistoryFilter) {
  return items.filter(
    (item) =>
      filter === "all" ||
      (filter === "attention" &&
        ["FAILED", "DEAD_LETTER"].includes(item.status)) ||
      (filter === "pending" &&
        ["QUEUED", "SENDING", "SENT"].includes(item.status)) ||
      (filter === "delivered" && item.status === "DELIVERED"),
  );
}

export function messageLabel(key: string | null) {
  const labels: Record<string, string> = {
    APPOINTMENT_CONFIRMED: "Appointment confirmed",
    APPOINTMENT_RESCHEDULED: "Appointment rescheduled",
    APPOINTMENT_CANCELLED: "Appointment cancelled",
    TECHNICIAN_ON_THE_WAY: "Technician on the way",
  };
  return key && Object.hasOwn(labels, key) ? labels[key] : "SMS activity";
}

export function statusLabel(status: SmsHistoryItem["status"]) {
  const labels: Record<SmsHistoryItem["status"], string> = {
    QUEUED: "Queued",
    SENDING: "Sending",
    SENT: "Sent · delivery unconfirmed",
    DELIVERED: "Delivered",
    FAILED: "Failed · retry may be pending",
    DEAD_LETTER: "Stopped · review required",
    RECEIVED: "Received",
  };
  return labels[status] ?? "Unknown status";
}

export function validHistoryJobId(value: string) {
  return (
    value === "" ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function historyTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : date.toISOString().replace("T", " ").replace(".000Z", " UTC");
}
