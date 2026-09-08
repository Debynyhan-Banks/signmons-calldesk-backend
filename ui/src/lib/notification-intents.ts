import type { SmsEnqueueIntentItem } from "./api";

export type IntentFilter = "all" | "pending" | "attention" | "queued";

// Snapshot eligibility is only a UI hint. The POST rechecks current role and state.
export function canReviewIntentRetry(
  item: SmsEnqueueIntentItem,
  allowed: boolean,
) {
  return (
    allowed === true &&
    item.status === "FAILED" &&
    item.attemptCount === 5 &&
    item.communicationEventId === null &&
    ["APPOINTMENT_CONFIRMED", "TECHNICIAN_ON_THE_WAY"].includes(
      item.templateKey,
    ) &&
    typeof item.updatedAt === "string" &&
    Number.isFinite(Date.parse(item.updatedAt)) &&
    new Date(item.updatedAt).toISOString() === item.updatedAt
  );
}

export function retryOutcomeMessage(status?: number) {
  if (status === 401 || status === 403)
    return "Retry access denied. Load history with a current owner or admin token before reviewing again.";
  if (status === 409)
    return "The intent or job changed. Load history and review the current state before retrying.";
  if (status === 404)
    return "The intent is unavailable. Load history to refresh.";
  if (status === 429)
    return "Retry request limit reached. Wait a minute, then load history before reviewing again.";
  if (status === 400)
    return "The retry request was not accepted. Load history to review a fresh snapshot.";
  return "Retry outcome uncertain: the server may have accepted the request. Load history to check its current state before considering another retry.";
}

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
