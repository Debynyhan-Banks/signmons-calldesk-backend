// Narrow read-only boundary. No insert/update/delete or raw Calendar payload.
export type CalendarEventSnapshot = {
  id: string;
  etag: string;
  status: string;
  start: string;
  end: string;
  tenantId: string;
  jobId: string;
  operationId: string;
  blockingSingleEvent: boolean;
};

export type CalendarReadResult =
  | { outcome: "found"; event: CalendarEventSnapshot }
  | { outcome: "unverified" | "unavailable" };

export abstract class CalendarEventReader {
  abstract read(
    calendarId: string,
    eventId: string,
  ): Promise<CalendarReadResult>;
}
