import { ConflictException } from "@nestjs/common";

// Select only the existence of unfinished work; never expose Calendar metadata.
export const unfinishedCalendarOperations = {
  where: { finishedAt: null },
  select: { id: true },
  take: 1,
} as const;

export const noUnfinishedCalendarOperations = {
  none: { finishedAt: null },
} as const;

export function calendarOperationPending(job: {
  calendarOperations: ReadonlyArray<{ id: string }>;
}): boolean {
  // Missing selection is not evidence that the job is safe to consume.
  return (
    !Array.isArray(job.calendarOperations) || job.calendarOperations.length > 0
  );
}

export function requireCalendarOperationSettled(job: {
  calendarOperations: ReadonlyArray<{ id: string }>;
}): void {
  if (calendarOperationPending(job)) {
    throw new ConflictException(
      "Calendar synchronization is unfinished. Appointment details and actions are on hold; please contact the office before making plans or changes.",
    );
  }
}

export class CalendarOperationPendingError extends Error {}
