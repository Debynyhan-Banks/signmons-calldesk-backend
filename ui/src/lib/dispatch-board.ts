import type { DispatchBoardSummary, DispatchQueue } from "./api";

export type DispatchFilter = "all" | DispatchQueue;

export function formatDispatchDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatDispatchWindow(
  start: string | null,
  end: string | null,
  timezone: string,
): string {
  if (!start) return "Time not scheduled";
  const startDate = new Date(start);
  const endDate = end ? new Date(end) : null;
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(startDate);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(startDate);
  const endTime = endDate
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        minute: "2-digit",
      }).format(endDate)
    : null;
  return `${date} · ${time}${endTime ? `–${endTime}` : ""}`;
}

export function dispatchMetrics(items: DispatchBoardSummary[]) {
  return {
    total: items.length,
    newRequests: items.filter((item) => item.queue === "NEW_REQUEST").length,
    ready: items.filter((item) => item.queue === "READY_TO_ASSIGN").length,
    assigned: items.filter((item) => item.queue === "ASSIGNED").length,
    escalated: items.filter((item) => item.queue === "ESCALATED").length,
  };
}

export function filterDispatchBoard(
  items: DispatchBoardSummary[],
  filter: DispatchFilter,
  search: string,
) {
  const query = search.trim().toLowerCase();
  return items.filter((item) => {
    const matchesFilter = filter === "all" || item.queue === filter;
    const matchesSearch =
      !query ||
      item.reference.toLowerCase().includes(query) ||
      item.serviceCategory.toLowerCase().includes(query) ||
      item.status.toLowerCase().includes(query) ||
      item.assignedTechnician?.fullName.toLowerCase().includes(query);
    return matchesFilter && matchesSearch;
  });
}

export function dispatchQueueLabel(queue: DispatchQueue): string {
  const labels: Record<DispatchQueue, string> = {
    NEW_REQUEST: "New request",
    READY_TO_ASSIGN: "Ready to assign",
    ASSIGNED: "Assigned",
    ESCALATED: "Escalated",
  };
  return labels[queue];
}
