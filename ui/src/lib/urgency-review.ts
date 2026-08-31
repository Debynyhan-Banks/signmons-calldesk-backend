import type { UrgencyLevel, UrgencyReviewSummary } from "./api";

export type UrgencyFilter = "all" | "emergency" | "high" | "standard";

export function urgencyMetrics(items: UrgencyReviewSummary[]) {
  return {
    total: items.length,
    emergency: items.filter((item) => item.urgency === "EMERGENCY").length,
    high: items.filter((item) => item.urgency === "HIGH").length,
    standard: items.filter((item) => item.urgency === "STANDARD").length,
  };
}

export function filterUrgencyReviews(
  items: UrgencyReviewSummary[],
  filter: UrgencyFilter,
  search: string,
) {
  const query = search.trim().toLowerCase();
  return items.filter((item) => {
    const matchesFilter =
      filter === "all" || item.urgency.toLowerCase() === filter;
    const matchesSearch =
      !query ||
      item.reference.toLowerCase().includes(query) ||
      item.serviceCategory.toLowerCase().includes(query) ||
      item.status.toLowerCase().includes(query);
    return matchesFilter && matchesSearch;
  });
}

export function urgencyLabel(level: UrgencyLevel): string {
  return level === "HIGH" ? "High priority" : level.toLowerCase();
}
