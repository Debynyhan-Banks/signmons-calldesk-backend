import { Injectable } from "@nestjs/common";
import { GoogleAuth } from "google-auth-library";
import {
  CalendarEventReader,
  CalendarReadResult,
} from "./calendar-event-reader";

// Deliberately unregistered until journal-aware consumer gates are implemented.
@Injectable()
export class GoogleCalendarEventReader extends CalendarEventReader {
  private readonly auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
  });

  async read(calendarId: string, eventId: string): Promise<CalendarReadResult> {
    try {
      const client = await this.auth.getClient();
      const headers = await client.getRequestHeaders();
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        {
          method: "GET",
          headers: Object.fromEntries(headers.entries()),
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
        },
      );
      // 404/410 can mean inaccessible/deleted; never authorize recreate/rollback.
      if (response.status === 404 || response.status === 410)
        return { outcome: "unverified" };
      if (!response.ok) return { outcome: "unavailable" };
      const body = record(await response.json());
      const privateFields = record(record(body.extendedProperties).private);
      const start = record(body.start);
      const end = record(body.end);
      return {
        outcome: "found",
        event: {
          id: value(body.id),
          etag: value(body.etag),
          status: value(body.status),
          start: value(start.dateTime),
          end: value(end.dateTime),
          tenantId: value(privateFields.signmonsTenantId),
          jobId: value(privateFields.signmonsJobId),
          operationId: value(privateFields.signmonsCalendarOperationId),
          blockingSingleEvent:
            !start.date &&
            !end.date &&
            !body.endTimeUnspecified &&
            !body.recurringEventId &&
            !body.recurrence &&
            (body.transparency === undefined ||
              body.transparency === "opaque") &&
            (body.eventType === undefined || body.eventType === "default"),
        },
      };
    } catch {
      // Includes authorization, timeout, redirect and malformed response failures.
      // Never log/return raw errors, tokens, Calendar content or provider bodies.
      return { outcome: "unavailable" };
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function value(input: unknown): string {
  return typeof input === "string" ? input : "";
}
