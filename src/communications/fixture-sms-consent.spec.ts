import { randomUUID } from "node:crypto";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { FixtureSmsConsent, FixtureSmsPolicy } from "./fixture-sms-consent";

describe("fixture-only SMS consent", () => {
  const credentials = new CustomerConsentCredentials({
    activeKeyId: "test",
    keys: { test: Buffer.alloc(32, 7) },
  });
  const tenantId = randomUUID(),
    sessionId = randomUUID();
  const token = credentials.issueSession({
    tenantId,
    sessionId,
    conversationId: randomUUID(),
  });
  let now: number, policy: FixtureSmsPolicy, model: FixtureSmsConsent;
  const request = (extra = {}) => ({
    sessionToken: token,
    action: "PROMPT",
    phone: "+12025550123",
    promptId: "",
    accepted: false,
    ...extra,
  });
  const prompt = () => model.handle(request());
  const capture = (p: Record<string, unknown>, extra = {}) =>
    model.handle(
      request({
        action: "CAPTURE",
        promptId: p.promptId,
        accepted: true,
        ...extra,
      }),
    );
  beforeEach(() => {
    now = Date.now();
    policy = {
      fixtureOnly: true,
      tenantId,
      sessionId,
      phone: "+12025550123",
      phoneRevision: 1,
      version: "fixture-v1",
      sender: "Fictional Heating",
      disclosure: "Fictional optional SMS disclosure.",
      optedOut: false,
      active: true,
    };
    model = new FixtureSmsConsent(
      credentials,
      () => policy,
      () => now,
    );
  });
  it("records only fixture evidence with exact retry and original deadline", () => {
    const p = prompt(),
      r = capture(p);
    now += 1000;
    expect(capture(p)).toEqual(r);
    expect(r).toMatchObject({
      fixtureOnly: true,
      liveConsentRecorded: false,
      deliveryAuthorized: false,
      state: "RECORDED",
      expiresAt: p.expiresAt,
    });
  });
  it("decline records no new grant", () =>
    expect(capture(prompt(), { accepted: false }).state).toBe("NOT_RECORDED"));
  it.each(["version", "phone", "sender", "disclosure"] as const)(
    "refuses changed %s",
    (field) => {
      const p = prompt();
      policy[field] += "changed";
      expect(() => capture(p)).toThrow();
    },
  );
  it("refuses changed phone revision", () => {
    const p = prompt();
    policy.phoneRevision++;
    expect(() => capture(p)).toThrow();
  });
  it("refuses changed tenant or session", () => {
    const p = prompt();
    policy.tenantId = randomUUID();
    expect(() => capture(p)).toThrow();
    policy.tenantId = tenantId;
    policy.sessionId = randomUUID();
    expect(() => capture(p)).toThrow();
  });
  it("does not clear a prior opt-out", () => {
    const p = prompt();
    policy.optedOut = true;
    expect(prompt().state).toBe("UNAVAILABLE");
    expect(() => capture(p)).toThrow();
    expect(policy.optedOut).toBe(true);
  });
  it("refuses expired and restarted prompts", () => {
    const p = prompt();
    now += 300000;
    expect(() => capture(p)).toThrow();
    model = new FixtureSmsConsent(credentials, () => policy);
    expect(() => capture(p)).toThrow();
  });
  it("refuses foreign credentials and missing policy", () => {
    const p = prompt();
    expect(() =>
      capture(p, {
        sessionToken: credentials.issueSession({
          tenantId: randomUUID(),
          sessionId,
          conversationId: randomUUID(),
        }),
      }),
    ).toThrow();
    model = new FixtureSmsConsent(credentials, () => undefined);
    expect(prompt).toThrow();
  });
  it("rejects extra fields and affirmative prompt requests", () => {
    expect(() => model.handle(request({ tenantId }))).toThrow();
    expect(() => model.handle(request({ accepted: true }))).toThrow();
  });
  it("uses only fixed relative policy paths, never browser URLs", () => {
    expect(prompt()).toMatchObject({
      privacyPath: "/fixture-sms-privacy",
      termsPath: "/fixture-sms-terms",
    });
    expect(() =>
      model.handle(request({ privacyPath: "https://evil.invalid" })),
    ).toThrow();
  });
  it("bounds retained entries", () => {
    for (let i = 0; i < 256; i++) prompt();
    expect(prompt).toThrow();
  });
});
