import { GoogleAuth } from "google-auth-library";
import { GoogleCalendarEventCreator } from "./google-calendar-event-creator";

describe("inactive Google CREATE adapter", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  const input = {
    calendarId: "saved/@fixture.invalid",
    eventId: "a".repeat(32),
    tenantId: "10000000-0000-4000-8000-000000000001",
    jobId: "20000000-0000-4000-8000-000000000002",
    operationId: "30000000-0000-4000-8000-000000000003",
    start: new Date("2099-01-01T14:00:00Z"),
    end: new Date("2099-01-01T15:00:00Z"),
    timeZone: "UTC",
    attemptDeadline: new Date(now + 8_000),
  };
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(now);
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
    { attemptDeadline: new Date(NaN) },
    { attemptDeadline: new Date(now) },
    { attemptDeadline: undefined as unknown as Date },
    { eventId: "wrong" },
    { start: new Date(0) },
    { timeZone: "bad/zone" },
    { tenantId: "wrong" },
  ])("does not dispatch invalid persisted input %j", async (change) => {
    await new GoogleCalendarEventCreator().create({ ...input, ...change });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uses only the persisted deadline's remaining budget", async () => {
    const timeout = jest.spyOn(AbortSignal, "timeout");
    jest.mocked(Date.now).mockReturnValue(now + 5_000);
    await new GoogleCalendarEventCreator().create(input);
    expect(timeout).toHaveBeenCalledWith(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(["client", "headers"])(
    "rejects delayed %s at the absolute deadline even before abort delivery",
    async (stage) => {
      const controller = new AbortController();
      jest.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      jest.spyOn(GoogleAuth.prototype, "getClient").mockImplementation(() => {
        if (stage === "client")
          jest.mocked(Date.now).mockReturnValue(now + 8_000);
        return Promise.resolve({
          getRequestHeaders: () => {
            jest.mocked(Date.now).mockReturnValue(now + 8_000);
            return Promise.resolve(new Headers());
          },
        }) as never;
      });
      await new GoogleCalendarEventCreator().create(input);
      expect(controller.signal.aborted).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("rejects an exhausted budget before loading credentials", async () => {
    jest.mocked(Date.now).mockReturnValue(now + 8_001);
    await new GoogleCalendarEventCreator().create(input);
    expect(GoogleAuth.prototype.getClient).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("caps an oversized caller deadline at the adapter bound", async () => {
    const controller = new AbortController();
    jest.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    jest.spyOn(GoogleAuth.prototype, "getClient").mockImplementation(() => {
      jest.mocked(Date.now).mockReturnValue(now + 8_000);
      return Promise.resolve({
        getRequestHeaders: () => Promise.resolve(new Headers()),
      }) as never;
    });
    await new GoogleCalendarEventCreator().create({
      ...input,
      attemptDeadline: new Date(now + 60_000),
    });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(8_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
