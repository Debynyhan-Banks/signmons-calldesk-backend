import type { SmsEnqueueIntentItem } from "./api";

export type IntentFilter = "all" | "pending" | "attention" | "queued";

export function filterIntents(
  items: SmsEnqueueIntentItem[],
  filter: IntentFilter,
  jobId = "",
) {
  return items.filter(
    (item) =>
      (!jobId || item.jobId.toLowerCase() === jobId.toLowerCase()) &&
      (filter === "all" ||
        (filter === "pending" && item.status === "PENDING") ||
        (filter === "attention" && ["STALE", "FAILED"].includes(item.status)) ||
        (filter === "queued" && item.status === "QUEUED")),
  );
}

export function intentStatusLabel(status: SmsEnqueueIntentItem["status"]) {
  const labels = {
    PENDING: "Pending enqueue",
    QUEUED: "Queue acknowledged · not delivery",
    STALE: "Stopped · state changed",
    FAILED: "Stopped · retries exhausted",
  };
  return Object.hasOwn(labels, status)
    ? labels[status]
    : "Unknown intent status";
}

export function intentFailureLabel(code: string | null) {
  if (code === null) return "None recorded";
  if (code === "stale_lifecycle_state") return "Lifecycle state changed";
  if (code === "enqueue_failed") return "Enqueue failed";
  return "Unrecognized failure code";
}
