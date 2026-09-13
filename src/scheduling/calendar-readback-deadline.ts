import { CALENDAR_CREATE_READER_GRACE_MS } from "./calendar-event-creator";

// This boundary is independent of a reviewed admission's changing CAS version.
// Null legacy rows retain the existing persisted updatedAt-based grace.
export function calendarReadbackNotBefore(operation: {
  updatedAt: Date;
  readbackNotBefore?: Date | null;
}): Date {
  return (
    operation.readbackNotBefore ??
    new Date(operation.updatedAt.getTime() + CALENDAR_CREATE_READER_GRACE_MS)
  );
}

export function calendarReadbackReady(notBefore: Date): boolean {
  return (
    Number.isFinite(notBefore.getTime()) && Date.now() >= notBefore.getTime()
  );
}
