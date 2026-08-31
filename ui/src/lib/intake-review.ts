import type { IntakeReviewSummary } from "./api";

export type IntakeFilter = "all" | "missing" | "ready" | "priority";

export const missingFieldLabels: Record<string, string> = {
  customerName: "Customer name",
  phone: "Phone",
  serviceAddress: "Service address",
  serviceCategory: "Service category",
  issueSummary: "Issue summary",
  urgency: "Urgency",
  preferredWindow: "Preferred window",
  paymentStatus: "Deposit status",
};

export function filterIntakes(
  intakes: IntakeReviewSummary[],
  filter: IntakeFilter,
  search: string,
): IntakeReviewSummary[] {
  const query = search.trim().toLowerCase();
  return intakes.filter((intake) => {
    const matchesFilter =
      filter === "all" ||
      (filter === "missing" && intake.readiness.state === "MISSING_INFO") ||
      (filter === "ready" && intake.readiness.state === "READY_TO_ASSIGN") ||
      (filter === "priority" && intake.priority !== "STANDARD");
    if (!matchesFilter) return false;
    if (!query) return true;
    return [
      intake.customerName,
      intake.phone,
      intake.serviceAddress,
      intake.serviceCategory,
      intake.issueSummary,
      intake.reference,
    ].some((value) => value?.toLowerCase().includes(query));
  });
}

export function intakeMetrics(intakes: IntakeReviewSummary[]) {
  return {
    total: intakes.length,
    missing: intakes.filter(
      (intake) => intake.readiness.state === "MISSING_INFO",
    ).length,
    ready: intakes.filter(
      (intake) => intake.readiness.state === "READY_TO_ASSIGN",
    ).length,
    priority: intakes.filter((intake) => intake.priority !== "STANDARD").length,
  };
}
