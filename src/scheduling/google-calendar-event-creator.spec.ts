import { GoogleAuth } from "google-auth-library";
import { GoogleCalendarEventCreator } from "./google-calendar-event-creator";

describe("inactive Google CREATE adapter", () => {
  const input = {
    calendarId: "saved/@fixture.invalid",
    eventId: "a".repeat(32),
    tenantId: "10000000-0000-4000-8000-000000000001",
    jobId: "20000000-0000-4000-8000-000000000002",
    operationId: "30000000-0000-4000-8000-000000000003",
    start: new Date("2099-01-01T14:00:00Z"),
    end: new Date("2099-01-01T15:00:00Z"),
    timeZone: "UTC",
  };
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue({
      getRequestHeaders: jest
        .fn()
        .mockResolvedValue(new Headers({ authorization: "Bearer synthetic" })),
    } as never);
    fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("private ignored body"));
  });
  afterEach(() => jest.restoreAllMocks());
  it("POSTs saved ID and private ownership with no customer content or attendees", async () => {
    await new GoogleCalendarEventCreator().create(input);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.googleapis.com/calendar/v3/calendars/saved%2F%40fixture.invalid/events?sendUpdates=none",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body).toEqual({
      id: input.eventId,
      summary: "CallDesk appointment 20000000",
      status: "confirmed",
      eventType: "default",
      transparency: "opaque",
      visibility: "private",
      start: { dateTime: input.start.toISOString(), timeZone: "UTC" },
      end: { dateTime: input.end.toISOString(), timeZone: "UTC" },
      extendedProperties: {
        private: {
          signmonsTenantId: input.tenantId,
          signmonsJobId: input.jobId,
          signmonsCalendarOperationId: input.operationId,
        },
      },
      reminders: { useDefault: false },
    });
  });
  it.each([200, 201, 400, 401, 403, 404, 409, 429, 500, 503])(
    "never retries or trusts response status %s",
    async (status) => {
      fetchMock.mockResolvedValue(new Response("private", { status }));
      await expect(
        new GoogleCalendarEventCreator().create(input),
      ).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it("never retries a network/timeout error", async () => {
    fetchMock.mockRejectedValue(new Error("private"));
    await expect(
      new GoogleCalendarEventCreator().create(input),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("starts the write deadline before credential acquisition", async () => {
    const controller = new AbortController();
    jest.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let releaseAuth!: (value: unknown) => void;
    jest.spyOn(GoogleAuth.prototype, "getClient").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseAuth = resolve;
        }) as never,
    );
    const pending = new GoogleCalendarEventCreator().create(input);
    controller.abort();
    releaseAuth({
      getRequestHeaders: jest
        .fn()
        .mockResolvedValue(new Headers({ authorization: "Bearer synthetic" })),
    });
    await expect(pending).resolves.toBeUndefined();
    expect(AbortSignal.timeout).toHaveBeenCalledWith(8_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    { eventId: "wrong" },
    { start: new Date(0) },
    { timeZone: "bad/zone" },
    { tenantId: "wrong" },
  ])("does not dispatch invalid persisted input %j", async (change) => {
    await new GoogleCalendarEventCreator().create({ ...input, ...change });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
