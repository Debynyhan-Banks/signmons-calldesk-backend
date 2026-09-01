import type { TechnicianJobAction, TechnicianJobSummary } from "./api";

export type TechnicianJobGroup = "today" | "upcoming" | "completed";

export function technicianTokenFromHash(hash: string): string {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!value) return "";
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return "";
  }
}

export function technicianStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    ASSIGNED: "New assignment",
    ACCEPTED: "Accepted",
    EN_ROUTE: "On my way",
    IN_PROGRESS: "In progress",
    COMPLETED: "Completed",
  };
  return labels[status] ?? "Assigned";
}

export function technicianActionLabel(action: TechnicianJobAction): string {
  const labels: Record<TechnicianJobAction, string> = {
    accept: "Accept job",
    decline: "Decline",
    on_my_way: "I'm on my way",
    in_progress: "Start work",
    complete: "Complete job",
    cannot_take: "Can't take job",
  };
  return labels[action];
}

export function primaryTechnicianAction(
  job: TechnicianJobSummary,
): TechnicianJobAction | null {
  const order: TechnicianJobAction[] = [
    "accept",
    "on_my_way",
    "in_progress",
    "complete",
  ];
  return order.find((action) => job.availableActions.includes(action)) ?? null;
}

export function secondaryTechnicianActions(
  job: TechnicianJobSummary,
): TechnicianJobAction[] {
  const primary = primaryTechnicianAction(job);
  const hasCannotTake = job.availableActions.includes("cannot_take");
  return job.availableActions.filter(
    (action) =>
      action !== primary && !(action === "decline" && hasCannotTake),
  );
}

export function technicianGroupAfterAction(
  current: TechnicianJobGroup,
  action: TechnicianJobAction,
): TechnicianJobGroup {
  return action === "complete" ? "completed" : current;
}

export function shouldShowCustomerCall(job: TechnicianJobSummary): boolean {
  return job.technicianStatus !== "COMPLETED";
}
