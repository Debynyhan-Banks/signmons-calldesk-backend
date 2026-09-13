import {
  reviewStagingAddressBudget,
  stagingAddressPacketDigest,
  StagingAddressBudgetPacket,
  StagingAddressBudgetAuthority,
} from "./staging-address-budget-policy";

describe("inactive staging address budget policy", () => {
  const setup = () => {
    // Fictional rates/limits only; these are not an approved spending packet.
    const p: StagingAddressBudgetPacket = {
      mode: "STAGING_REVIEW_ONLY",
      version: "v1",
      approvalId: "approval",
      accountId: "account",
      projectId: "project",
      serviceId: "service",
      runtimeIdentity: "identity@example.invalid",
      tenantId: "tenant",
      sessionId: "session",
      currency: "USD",
      rateVersion: "rate-v1",
      costMicros: 7,
      validFrom: 100,
      validUntil: 200,
      account: { micros: 100, requests: 10 },
      tenant: { micros: 50, requests: 5 },
      session: { micros: 14, requests: 2 },
    };
    const a: StagingAddressBudgetAuthority = {
      environment: "staging",
      accountId: p.accountId,
      projectId: p.projectId,
      serviceId: p.serviceId,
      runtimeIdentity: p.runtimeIdentity,
      tenantId: p.tenantId,
      sessionId: p.sessionId,
      approvalId: p.approvalId,
      packetDigest: stagingAddressPacketDigest(p),
      rateVersion: p.rateVersion,
      costMicros: p.costMicros,
      rateValidUntil: 200,
      sessionExpiresAt: 200,
      enabled: true,
      now: 100,
      usage: {
        account: { micros: 0, requests: 0 },
        tenant: { micros: 0, requests: 0 },
        session: { micros: 0, requests: 0 },
      },
    };
    return { p, a };
  };
  it("reports policy readiness without spending or downstream authority", () => {
    const { p, a } = setup();
    const before = JSON.stringify({ p, a });
    expect(reviewStagingAddressBudget(p, a)).toEqual({
      status: "POLICY_READY",
      dispatchAuthorized: false,
      admissionAuthorized: false,
      deliveryAuthorized: false,
    });
    expect(JSON.stringify({ p, a })).toBe(before);
  });
  it("refuses absent approval authority", () => {
    expect(reviewStagingAddressBudget(setup().p).status).toBe("REFUSED");
  });
  it.each([null, {}, [], { mode: "FIXTURE_ONLY" }])(
    "refuses invalid packet %p",
    (p) => {
      expect(reviewStagingAddressBudget(p, setup().a).status).toBe("REFUSED");
    },
  );
  it.each([
    "accountId",
    "projectId",
    "serviceId",
    "runtimeIdentity",
    "tenantId",
    "sessionId",
    "approvalId",
    "rateVersion",
  ] as const)("refuses changed %s", (key) => {
    const { p, a } = setup();
    a[key] = "different";
    expect(reviewStagingAddressBudget(p, a).status).toBe("REFUSED");
  });
  it("refuses disabled authority and altered approval digest", () => {
    const { p, a } = setup();
    expect(reviewStagingAddressBudget(p, { ...a, enabled: false }).status).toBe(
      "REFUSED",
    );
    expect(
      reviewStagingAddressBudget(p, { ...a, packetDigest: "changed" }).status,
    ).toBe("REFUSED");
    p.account.micros++;
    expect(reviewStagingAddressBudget(p, a).status).toBe("REFUSED");
  });
  it.each([99, 200, NaN, Infinity, -1, 100.5])(
    "refuses invalid/out-of-window clock %p",
    (now) => {
      const { p, a } = setup();
      a.now = now;
      expect(reviewStagingAddressBudget(p, a).status).toBe("REFUSED");
    },
  );
  it.each(["rateValidUntil", "sessionExpiresAt"] as const)(
    "refuses packet beyond %s",
    (key) => {
      const { p, a } = setup();
      a[key] = 199;
      expect(reviewStagingAddressBudget(p, a).status).toBe("REFUSED");
    },
  );
  it.each(["account", "tenant", "session"] as const)(
    "checks retained liability and request cap at %s",
    (key) => {
      const { p, a } = setup();
      a.usage[key].micros = p[key].micros - p.costMicros;
      a.usage[key].requests = p[key].requests - 1;
      expect(reviewStagingAddressBudget(p, a).status).toBe("POLICY_READY");
      a.usage[key].micros++;
      expect(reviewStagingAddressBudget(p, a).status).toBe("REFUSED");
      a.usage[key].micros--;
      a.usage[key].requests++;
      expect(reviewStagingAddressBudget(p, a).status).toBe("REFUSED");
    },
  );
  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "refuses invalid usage %p",
    (micros) => {
      const { p, a } = setup();
      a.usage.account.micros = micros;
      expect(reviewStagingAddressBudget(p, a).status).toBe("REFUSED");
    },
  );
  it("refuses unknown fields and fixture/production modes", () => {
    const { p, a } = setup();
    for (const value of [
      { ...p, extra: true },
      { ...p, mode: "FIXTURE_ONLY" },
      { ...p, mode: "LIVE" },
      { ...p, account: { ...p.account, freeCredit: 100 } },
    ])
      expect(reviewStagingAddressBudget(value, a).status).toBe("REFUSED");
    expect(
      reviewStagingAddressBudget(p, {
        ...a,
        environment: "production",
      } as unknown as StagingAddressBudgetAuthority).status,
    ).toBe("REFUSED");
  });
  it.each([0, -1, NaN, 0.5])(
    "refuses invalid paid liability %p",
    (costMicros) => {
      const { p, a } = setup();
      p.costMicros = costMicros;
      a.costMicros = costMicros;
      a.packetDigest = stagingAddressPacketDigest(p);
      expect(reviewStagingAddressBudget(p, a).status).toBe("REFUSED");
    },
  );
  it("refuses changed rates even with an otherwise approved packet", () => {
    const { p, a } = setup();
    a.costMicros++;
    expect(reviewStagingAddressBudget(p, a).status).toBe("REFUSED");
  });
  it("cannot overflow remaining-liability calculation", () => {
    const { p, a } = setup();
    p.account.micros = Number.MAX_SAFE_INTEGER;
    a.packetDigest = stagingAddressPacketDigest(p);
    a.usage.account.micros = Number.MAX_SAFE_INTEGER;
    expect(reviewStagingAddressBudget(p, a).status).toBe("REFUSED");
  });
});
