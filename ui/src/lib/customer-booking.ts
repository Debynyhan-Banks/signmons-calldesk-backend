import type { CustomerBookingStatus } from "./api";

export function customerBookingStateLabel(
  state: CustomerBookingStatus["bookingState"],
): string {
  const labels: Record<CustomerBookingStatus["bookingState"], string> = {
    REQUEST_RECEIVED: "Request received",
    PENDING_CUSTOMER_CONFIRMATION: "Waiting for your confirmation",
    CONFIRMED: "Appointment confirmed",
    RESCHEDULE_REQUESTED: "Reschedule request sent",
    CANCELLED: "Appointment cancelled",
    COMPLETED: "Service completed",
  };
  return labels[state];
}

export function customerBookingProgress(
  state: CustomerBookingStatus["bookingState"],
): number {
  if (state === "REQUEST_RECEIVED") return 1;
  if (state === "PENDING_CUSTOMER_CONFIRMATION") return 2;
  if (state === "RESCHEDULE_REQUESTED") return 2;
  return 3;
}

export function formatCustomerBookingDate(
  value: string | null,
  timeZone = "America/New_York",
): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
