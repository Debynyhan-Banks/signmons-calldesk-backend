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

// An insert response is never finalization proof. No retry/update/delete method.
export abstract class CalendarEventCreator {
  abstract create(input: CalendarCreateRequest): Promise<void>;
}
