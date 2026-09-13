import { Injectable } from "@nestjs/common";
import { GoogleAuth } from "google-auth-library";
import {
  CALENDAR_CREATE_ATTEMPT_TIMEOUT_MS,
  CalendarCreateRequest,
  CalendarEventCreator,
} from "./calendar-event-creator";

// Inactive adapter. Never register until the complete execution protocol is approved.
@Injectable()
export class GoogleCalendarEventCreator extends CalendarEventCreator {
  private readonly auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
  });

  async create(input: CalendarCreateRequest): Promise<void> {
    if (
      !/^[0-9a-f]{32}$/.test(input.eventId) ||
      !input.calendarId.trim() ||
      input.calendarId.length > 1024
    )
      return;
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      ![input.tenantId, input.jobId, input.operationId].every((id) =>
        uuid.test(id),
      )
    )
      return;
    if (
      !(input.attemptDeadline instanceof Date) ||
      !Number.isFinite(input.attemptDeadline.getTime())
    )
      return;
    const now = Date.now();
    const deadline = Math.min(
      input.attemptDeadline.getTime(),
      now + CALENDAR_CREATE_ATTEMPT_TIMEOUT_MS,
    );
    if (deadline <= now) return;
    // Carry the persisted claim's remaining budget through auth and transport.
    // The wall-clock check also rejects late auth when timer delivery is delayed.
    const signal = AbortSignal.timeout(deadline - now);
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
      const client = await this.auth.getClient();
      const headers = await client.getRequestHeaders();
      signal.throwIfAborted();
      if (Date.now() >= deadline) return;
      if (
        !(input.start instanceof Date) ||
        !(input.end instanceof Date) ||
        !(input.start.getTime() > Date.now()) ||
        !(input.end > input.start)
      )
        return;
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events?sendUpdates=none`,
        {
          method: "POST",
          headers: {
            ...Object.fromEntries(headers.entries()),
            "content-type": "application/json",
          },
          redirect: "error",
          signal,
          body: JSON.stringify({
            id: input.eventId,
            summary: `CallDesk appointment ${input.jobId.slice(0, 8)}`,
            status: "confirmed",
            eventType: "default",
            transparency: "opaque",
            visibility: "private",
            start: {
              dateTime: input.start.toISOString(),
              timeZone: input.timeZone,
            },
            end: {
              dateTime: input.end.toISOString(),
              timeZone: input.timeZone,
            },
            extendedProperties: {
              private: {
                signmonsTenantId: input.tenantId,
                signmonsJobId: input.jobId,
                signmonsCalendarOperationId: input.operationId,
              },
            },
            reminders: { useDefault: false },
          }),
        },
      );
      // Ignore all response bodies/statuses, including 2xx and 409: read-back is
      // mandatory. No attendees, automatic retry, replacement ID or raw logging.
      await response.body?.cancel();
    } catch {
      // Auth, transport and timeout outcomes are uncertain, never absence proof.
    }
  }
}
