import { GoogleAddressOAuthTransport } from "./google-address-oauth.transport";
import { GoogleAddressRequest } from "./google-address.adapter";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("inactive Google address OAuth transport", () => {
  const input = (): GoogleAddressRequest => ({
    address: {
      regionCode: "US",
      administrativeArea: "OH",
      locality: "Test City",
      postalCode: "44101",
      addressLines: ["123 Fictional Street"],
    },
    enableUspsCass: true,
  });
  const response = () =>
    new Response(JSON.stringify({ result: { verdict: {} } }), {
      headers: { "content-type": "application/json" },
    });
  const setup = (enabled = true) => {
    const token = jest.fn().mockResolvedValue("synthetic-token");
    const send = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(() => Promise.resolve(response()));
    return {
      token,
      send,
      transport: new GoogleAddressOAuthTransport(enabled, {
        token,
        fetch: send,
      }),
    };
  };
  afterEach(() => jest.useRealTimers());

  it("refuses an already aborted operation before credentials", async () => {
    const s = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await s.transport.validate(input(), controller.signal)).toEqual({
      status: "UNAVAILABLE",
    });
    expect(s.token).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
  });

  it("operation abort cancels streaming and removes its listener", async () => {
    const s = setup();
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, "removeEventListener");
    const cancel = jest.fn();
    s.send.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const pending = s.transport.validate(input(), controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    expect(await pending).toEqual({ status: "UNAVAILABLE" });
    expect(cancel).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("remains absent from application registration and the fixture adapter", () => {
    for (const file of [
      "communications.module.ts",
      "google-address.adapter.ts",
    ]) {
      expect(readFileSync(join(__dirname, file), "utf8")).not.toContain(
        "GoogleAddressOAuthTransport",
      );
    }
  });

  it("bounds streamed response time as well as request time", async () => {
    jest.useFakeTimers();
    const s = setup();
    const cancel = jest.fn();
    s.send.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const pending = s.transport.validate(input());
    await jest.advanceTimersByTimeAsync(8000);
    expect(await pending).toEqual({ status: "UNAVAILABLE" });
    expect(s.send.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });

  it("defaults off and does not acquire credentials or fetch", async () => {
    expect(await new GoogleAddressOAuthTransport().validate(input())).toEqual({
      status: "DISABLED",
    });
    const s = setup(false);
    expect(await s.transport.validate(input())).toEqual({ status: "DISABLED" });
    expect(s.token).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
  });

  it("uses one fixed HTTPS POST, OAuth and explicit project without retries", async () => {
    const s = setup();
    expect(await s.transport.validate(input())).toEqual({
      status: "RESPONSE",
      body: { result: { verdict: {} } },
    });
    expect(s.send).toHaveBeenCalledTimes(1);
    const [url, options] = s.send.mock.calls[0];
    expect(url).toBe(
      "https://addressvalidation.googleapis.com/v1:validateAddress",
    );
    expect(options).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer synthetic-token",
        "Content-Type": "application/json",
        "X-Goog-User-Project": "signmons",
      },
    });
    expect(JSON.parse(options?.body as string)).toEqual(input());
  });

  it.each([
    { ...input(), sessionToken: "forbidden" },
    { ...input(), enableUspsCass: false },
    { ...input(), address: { ...input().address, regionCode: "CA" } },
    { ...input(), address: { ...input().address, administrativeArea: "PA" } },
    { ...input(), address: { ...input().address, postalCode: "bad" } },
    { ...input(), address: { ...input().address, addressLines: [] } },
    { ...input(), address: { ...input().address, locality: "bad\ncity" } },
    { ...input(), address: { ...input().address, recipients: ["private"] } },
    {
      ...input(),
      address: {
        ...input().address,
        addressLines: ["x".repeat(150), "y".repeat(150)],
      },
    },
  ])("refuses invalid input before any credential access", async (value) => {
    const s = setup();
    expect(await s.transport.validate(value as GoogleAddressRequest)).toEqual({
      status: "INVALID_INPUT",
    });
    expect(s.token).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
  });

  it.each([null, "", "bad\r\ntoken"])(
    "refuses absent or malformed token",
    async (value) => {
      const s = setup();
      s.token.mockResolvedValue(value);
      expect(await s.transport.validate(input())).toEqual({
        status: "UNAVAILABLE",
      });
      expect(s.send).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 429, 500, 302])(
    "sanitizes HTTP %s without retry",
    async (status) => {
      const s = setup();
      s.send.mockResolvedValue(
        new Response("private provider detail", { status }),
      );
      expect(await s.transport.validate(input())).toEqual({
        status: "UNAVAILABLE",
      });
      expect(s.send).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "not json",
    "[]",
    "null",
    "{}",
    '{"result":null}',
    '"private"',
    "x".repeat(65537),
  ])("refuses malformed, missing-result or oversized body", async (body) => {
    const s = setup();
    s.send.mockResolvedValue(
      new Response(body, { headers: { "content-type": "application/json" } }),
    );
    expect(await s.transport.validate(input())).toEqual({
      status: "UNAVAILABLE",
    });
  });

  it("refuses incorrect content type", async () => {
    const s = setup();
    s.send.mockResolvedValue(new Response('{"result":{}}'));
    expect(await s.transport.validate(input())).toEqual({
      status: "UNAVAILABLE",
    });
  });

  it.each(["token", "send"])("sanitizes %s exceptions", async (port) => {
    const s = setup();
    s[port as "token" | "send"].mockRejectedValue(
      new Error("private token/address"),
    );
    expect(await s.transport.validate(input())).toEqual({
      status: "UNAVAILABLE",
    });
  });

  it("does not send when credentials arrive after deadline", async () => {
    jest.useFakeTimers();
    const s = setup();
    let resolve!: (value: string) => void;
    s.token.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done;
      }),
    );
    const pending = s.transport.validate(input());
    await jest.advanceTimersByTimeAsync(8000);
    expect(await pending).toEqual({ status: "UNAVAILABLE" });
    resolve("late-token");
    await Promise.resolve();
    expect(s.send).not.toHaveBeenCalled();
  });

  it("aborts a hanging HTTP request without retry", async () => {
    jest.useFakeTimers();
    const s = setup();
    s.send.mockReturnValue(new Promise(() => {}));
    const pending = s.transport.validate(input());
    await jest.advanceTimersByTimeAsync(8000);
    expect(await pending).toEqual({ status: "UNAVAILABLE" });
    expect(s.send.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it("snapshots input before asynchronous authentication", async () => {
    const s = setup();
    const value = input();
    const pending = s.transport.validate(value);
    value.address.addressLines[0] = "changed";
    await pending;
    expect(JSON.parse(s.send.mock.calls[0][1]?.body as string)).toEqual(
      input(),
    );
  });
});
