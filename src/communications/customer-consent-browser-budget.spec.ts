import { LocalCustomerBrowserBudget } from "./customer-consent-browser-budget";

describe("local browser budget (not distributed production protection)", () => {
  let now: number, budget: LocalCustomerBrowserBudget;
  beforeEach(() => {
    now = 0;
    budget = new LocalCustomerBrowserBudget(() => now);
  });
  it("admits four in flight, releases idempotently, and does not refund quota", () => {
    const leases = Array.from({ length: 4 }, () =>
      budget.acquire("127.0.0.1", "capture"),
    );
    expect(leases.every(Boolean)).toBe(true);
    expect(budget.acquire("127.0.0.2", "capture")).toBeNull();
    leases[0]?.();
    leases[0]?.();
    expect(budget.acquire("127.0.0.1", "capture")).toBeInstanceOf(Function);
    expect(budget.acquire("127.0.0.1", "capture")).toBeNull();
  });
  it("limits each peer to five starts even with leases released", () => {
    for (let i = 0; i < 5; i++) {
      const release = budget.acquire("127.0.0.1", "start");
      expect(release).toBeTruthy();
      release?.();
    }
    expect(budget.acquire("127.0.0.1", "start")).toBeNull();
    expect(budget.acquire("127.0.0.1", "capture")).toBeTruthy();
  });
  it("caps global starts despite rotating peer addresses", () => {
    for (let i = 1; i <= 10; i++) budget.acquire("127.0.0." + i, "start")?.();
    expect(budget.acquire("127.0.0.11", "start")).toBeNull();
  });
  it("caps peer and total requests and resets only at the exact window boundary", () => {
    for (let peer = 1; peer <= 3; peer++) {
      for (let i = 0; i < 20; i++) {
        const release = budget.acquire("127.0.0." + peer, "prompt");
        expect(release).toBeTruthy();
        release?.();
      }
      expect(budget.acquire("127.0.0." + peer, "capture")).toBeNull();
    }
    expect(budget.acquire("127.0.0.4", "capture")).toBeNull();
    now = 59999;
    expect(budget.acquire("127.0.0.4", "capture")).toBeNull();
    now = 60000;
    expect(budget.acquire("127.0.0.4", "capture")).toBeTruthy();
  });
  it("retains in-flight ownership across window rollover", () => {
    for (let i = 0; i < 4; i++) budget.acquire("127.0.0.1", "capture");
    now = 60000;
    expect(budget.acquire("127.0.0.2", "capture")).toBeNull();
  });
  it.each(["", "forwarded", "127.0.0.1,127.0.0.2"])(
    "refuses invalid peer %s",
    (peer) => {
      expect(budget.acquire(peer, "start")).toBeNull();
    },
  );
  it("refuses backwards or invalid clocks", () => {
    now = 100;
    budget.acquire("127.0.0.1", "start")?.();
    for (const bad of [99, -1, NaN, Infinity]) {
      now = bad;
      expect(budget.acquire("127.0.0.1", "start")).toBeNull();
    }
  });
});
