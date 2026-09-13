import { ConflictException } from "@nestjs/common";
import { JobStatus, type Job } from "@prisma/client";
import { calendarOperationPending } from "../scheduling/calendar-operation-guard";

type Reservation = Pick<
  Job,
  "status" | "calendarEventId" | "serviceWindowStart" | "serviceWindowEnd"
>;
type JobCalendarSnapshot = Reservation & {
  calendarOperations: ReadonlyArray<{ id: string }>;
};

// Scope is job/field consumption, not Calendar reconciliation or job repair.
export function jobCalendarPending(job: JobCalendarSnapshot): boolean {
  return (
    calendarOperationPending(job) ||
    Boolean(
      job.status === JobStatus.ACCEPTED &&
        !job.calendarEventId?.trim() &&
        (job.serviceWindowStart || job.serviceWindowEnd),
    )
  );
}

export function requireJobCalendarSettled(job: JobCalendarSnapshot): void {
  if (jobCalendarPending(job)) {
    throw new ConflictException(
      "Calendar synchronization is unfinished. Appointment details and actions are on hold; please contact the office before making plans or changes.",
    );
  }
}

// Compare exact observed fields on write: the request's version alone does not
// prove that the reservation checked above is the reservation being mutated.
export function jobReservationSnapshot(job: Reservation): Reservation {
  return {
    status: job.status,
    calendarEventId: job.calendarEventId,
    serviceWindowStart: job.serviceWindowStart,
    serviceWindowEnd: job.serviceWindowEnd,
  };
}
