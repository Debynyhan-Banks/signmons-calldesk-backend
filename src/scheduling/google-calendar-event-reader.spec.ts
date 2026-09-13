import { GoogleAuth } from "google-auth-library";
import { GoogleCalendarEventReader } from "./google-calendar-event-reader";

describe("Google Calendar read-only adapter", () => {
  let fetchMock: jest.SpyInstance;
  const event = {
    id: "event",
    etag: '"version"',
    status: "confirmed",
    start: { dateTime: "2026-09-09T14:00:00Z" },
    end: { dateTime: "2026-09-09T15:00:00Z" },
    extendedProperties: {
      private: {
        signmonsTenantId: "tenant",
        signmonsJobId: "job",
        signmonsCalendarOperationId: "operation",
        privateSecret: "omit",
      },
    },
    summary: "private customer",
    description: "private content",
    location: "private address",
  };
  beforeEach(() => {
    jest.spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue({
      getRequestHeaders: jest
        .fn()
        .mockResolvedValue(new Headers({ Authorization: "Bearer synthetic" })),
    } as never);
    fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(event)));
  });
  afterEach(() => jest.restoreAllMocks());

  it("only GETs the encoded saved target and returns allowlisted evidence", async () => {
    const result = await new GoogleCalendarEventReader().read(
      "calendar/@test.invalid",
      "event/?target",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.googleapis.com/calendar/v3/calendars/calendar%2F%40test.invalid/events/event%2F%3Ftarget",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toEqual({
      outcome: "found",
      event: {
        id: "event",
        etag: '"version"',
        status: "confirmed",
        start: event.start.dateTime,
        end: event.end.dateTime,
        tenantId: "tenant",
        jobId: "job",
        operationId: "operation",
        blockingSingleEvent: true,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|Bearer|synthetic/);
  });
  it.each([404, 410])(
    "treats %s as unverified, not authority to recreate",
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response("private provider error", { status }),
      );
      await expect(
        new GoogleCalendarEventReader().read("calendar", "event"),
      ).resolves.toEqual({ outcome: "unverified" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it.each([401, 403, 429, 500, 503])(
    "holds %s without retry or error leakage",
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response("private provider error", { status }),
      );
      await expect(
        new GoogleCalendarEventReader().read("calendar", "event"),
      ).resolves.toEqual({ outcome: "unavailable" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it("holds transport/timeout failures without leaking tokens or making another request", async () => {
    fetchMock.mockRejectedValue(new Error("private token in network failure"));
    await expect(
      new GoogleCalendarEventReader().read("calendar", "event"),
    ).resolves.toEqual({ outcome: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("holds malformed JSON", async () => {
    fetchMock.mockResolvedValue(new Response("not JSON"));
    await expect(
      new GoogleCalendarEventReader().read("calendar", "event"),
    ).resolves.toEqual({ outcome: "unavailable" });
  });
  it("makes no Calendar request when authorization is unavailable", async () => {
    jest
      .mocked(GoogleAuth.prototype.getClient)
      .mockRejectedValue(new Error("private credentials"));
    await expect(
      new GoogleCalendarEventReader().read("calendar", "event"),
    ).resolves.toEqual({ outcome: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    { start: { date: "2026-09-09" } },
    { recurrence: ["RRULE:FREQ=DAILY"] },
    { recurringEventId: "parent" },
    { transparency: "transparent" },
    { eventType: "outOfOffice" },
    { endTimeUnspecified: true },
  ])("rejects non-booking shapes: %p", async (change) => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ...event, ...change })),
    );
    expect(
      await new GoogleCalendarEventReader().read("calendar", "event"),
    ).toMatchObject({
      outcome: "found",
      event: { blockingSingleEvent: false },
    });
  });
});
