export type CalendarCreateRequest = {
  calendarId: string;
  eventId: string;
  tenantId: string;
  jobId: string;
  operationId: string;
  start: Date;
  end: Date;
  timeZone: string;
};

export const CALENDAR_CREATE_ATTEMPT_TIMEOUT_MS = 8_000;
export const CALENDAR_CREATE_READER_GRACE_MS = 10_000;

// An insert response is never finalization proof. Implementations must bound
// the complete write window and must not start or continue a provider write
// after CALENDAR_CREATE_ATTEMPT_TIMEOUT_MS. No retry/update/delete method.
export abstract class CalendarEventCreator {
  abstract create(input: CalendarCreateRequest): Promise<void>;
}
