import { GoogleAddressOperation } from "./google-address-operation";
import { GoogleAddressRequest } from "./google-address.adapter";

describe("inactive address operation composition", () => {
  const input = { sessionToken: "synthetic-session", requestId: "request" };
  const request: GoogleAddressRequest = {
    address: {
      regionCode: "US",
      administrativeArea: "OH",
      locality: "Test City",
      postalCode: "44101",
      addressLines: ["123 Fictional Street"],
    },
    enableUspsCass: true,
  };
  const claim = {
    claimed: true,
    attemptId: "attempt",
    executionDeadline: 9000,
    intentId: "intent",
    revision: 2,
  };
  const setup = () => {
    const execute = jest.fn().mockResolvedValue(claim);
    const complete = jest
      .fn()
      .mockResolvedValue({ completed: true, state: "OBSERVED" });
    const token = jest.fn().mockResolvedValue("synthetic-token");
    const send = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ result: { private: "discard-me" } }), {
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    const readRequest = jest.fn().mockResolvedValue(request);
    const operation = new GoogleAddressOperation({
      mode: "FIXTURE_ONLY",
      ledger: { execute, complete },
      ports: { token, fetch: send },
      readRequest,
    });
    return { execute, complete, token, send, readRequest, operation };
  };
  beforeEach(() => jest.useFakeTimers({ now: 1000 }));
  afterEach(() => jest.useRealTimers());
  it("defaults disabled", async () => {
    expect(await new GoogleAddressOperation().run(input)).toMatchObject({
      status: "DISABLED",
      addressVerified: false,
    });
  });
  it("claims before loading the trusted revision and discards provider content", async () => {
    const s = setup();
    expect(await s.operation.run(input)).toEqual({
      status: "OBSERVED",
      fixtureOnly: true,
      addressVerified: false,
      county: "UNKNOWN",
      admissionAuthorized: false,
      deliveryAuthorized: false,
    });
    expect(s.execute).toHaveBeenNthCalledWith(1, {
      ...input,
      action: "reserve",
    });
    expect(s.execute).toHaveBeenNthCalledWith(2, { ...input, action: "claim" });
    expect(s.readRequest).toHaveBeenCalledWith({
      sessionToken: input.sessionToken,
      intentId: "intent",
      revision: 2,
    });
    expect(s.execute.mock.invocationCallOrder[1]).toBeLessThan(
      s.readRequest.mock.invocationCallOrder[0],
    );
    expect(s.readRequest.mock.invocationCallOrder[0]).toBeLessThan(
      s.token.mock.invocationCallOrder[0],
    );
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(s.complete.mock.calls)).not.toContain("discard-me");
  });
  it.each(["denied", "duplicate", "missing-binding", "missing-address"])(
    "refuses %s without credentials",
    async (failure) => {
      const s = setup();
      if (failure === "denied")
        s.execute.mockRejectedValue(Error("budget refused"));
      if (failure === "duplicate")
        s.execute.mockResolvedValue({ ...claim, claimed: false });
      if (failure === "missing-binding")
        s.execute.mockResolvedValue({ ...claim, intentId: undefined });
      if (failure === "missing-address") s.readRequest.mockResolvedValue(null);
      expect(await s.operation.run(input)).toMatchObject({
        status: "UNCERTAIN",
      });
      expect(s.token).not.toHaveBeenCalled();
      expect(s.send).not.toHaveBeenCalled();
    },
  );
  it("provider failure is durably uncertain, with no retry", async () => {
    const s = setup();
    s.send.mockRejectedValue(Error("private provider failure"));
    expect(await s.operation.run(input)).toMatchObject({ status: "UNCERTAIN" });
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.complete).toHaveBeenCalledWith({
      ...input,
      attemptId: "attempt",
      state: "UNCERTAIN",
    });
  });
  it("lost completion acknowledgement cannot publish observation", async () => {
    const s = setup();
    s.complete.mockRejectedValue(Error("lost ack"));
    expect(await s.operation.run(input)).toMatchObject({ status: "UNCERTAIN" });
  });
  it("the shorter claimed deadline prevents late credential dispatch", async () => {
    const s = setup();
    s.execute.mockResolvedValue({ ...claim, executionDeadline: 2000 });
    let resolve!: (token: string) => void;
    s.token.mockImplementation(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const pending = s.operation.run(input);
    await jest.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: "UNCERTAIN" });
    resolve("late-token");
    await jest.advanceTimersByTimeAsync(0);
    expect(s.send).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  it("deadline cancellation reaches a hanging HTTP request", async () => {
    const s = setup();
    s.execute.mockResolvedValue({ ...claim, executionDeadline: 2000 });
    s.send.mockImplementation(() => new Promise<Response>(() => undefined));
    const pending = s.operation.run(input);
    await jest.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: "UNCERTAIN" });
    expect(s.send.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});
