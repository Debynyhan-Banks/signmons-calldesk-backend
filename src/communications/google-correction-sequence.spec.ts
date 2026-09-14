import { GoogleCorrectionSequence } from "./google-correction-sequence";

describe("volatile Google correction sequence", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it("isolates keys, consumes once, and never serializes IDs", () => {
    const cache = new GoogleCorrectionSequence();
    expect(
      cache.remember("tenant/session/policy", id, Date.now() + 600000),
    ).toBe(true);
    expect(JSON.stringify(cache)).toBe("{}");
    expect(cache.take("other/session/policy")).toBeUndefined();
    expect(cache.take("tenant/session/policy")).toBe(id);
    expect(cache.take("tenant/session/policy")).toBeUndefined();
  });
  it.each([1000, 300000])(
    "deletes at the shorter session/TTL expiry %s",
    (ttl) => {
      const cache = new GoogleCorrectionSequence();
      cache.remember("key", id, Date.now() + (ttl === 1000 ? ttl : 600000));
      jest.advanceTimersByTime(ttl);
      expect(cache.take("key")).toBeUndefined();
    },
  );
  it("refuses invalid IDs, expired sessions and capacity overflow", () => {
    const cache = new GoogleCorrectionSequence();
    expect(cache.remember("key", "raw-provider-data", Date.now() + 1000)).toBe(
      false,
    );
    expect(cache.remember("key", id, Date.now())).toBe(false);
    for (let i = 0; i < 1000; i++)
      expect(cache.remember(String(i), id, Date.now() + 1000)).toBe(true);
    expect(cache.remember("overflow", id, Date.now() + 1000)).toBe(false);
  });
});
