export type CalendarCreateRequest = {
  calendarId: string;
  eventId: string;
  tenantId: string;
  jobId: string;
  operationId: string;
  start: Date;
  end: Date;
  timeZone: string;
  // Absolute deadline derived from the persisted UNCERTAIN attempt timestamp.
  attemptDeadline: Date;
};

export const CALENDAR_CREATE_ATTEMPT_TIMEOUT_MS = 8_000;
export const CALENDAR_CREATE_READER_GRACE_MS = 10_000;

// An insert response is never finalization proof. Implementations must refuse
// dispatch after attemptDeadline and abort client transport with its remaining
// budget, including time spent waiting before adapter entry.
// No retry/update/delete method; client abort is not provider rollback proof.
export abstract class CalendarEventCreator {
  abstract create(input: CalendarCreateRequest): Promise<void>;
}
