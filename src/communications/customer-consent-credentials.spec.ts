import { createHmac, randomUUID } from "node:crypto";
import {
  CustomerConsentCredentials,
  CONSENT_SESSION_MS,
  CONSENT_PROMPT_MS,
  CONSENT_PROMPT_DIGEST,
} from "./customer-consent-credentials";
describe("local customer-consent credentials", () => {
  const key = Buffer.alloc(32, 7),
    other = Buffer.alloc(32, 8),
    now = 1900000000000;
  const scope = {
    tenantId: randomUUID(),
    conversationId: randomUUID(),
    sessionId: randomUUID(),
  };
  const model = () =>
    new CustomerConsentCredentials({
      activeKeyId: "fixture1",
      keys: { fixture1: key },
    });
  const signed = (claims: object) => {
    const prefix =
      "fixture1." + Buffer.from(JSON.stringify(claims)).toString("base64url");
    return (
      prefix +
      "." +
      createHmac("sha256", key)
        .update("signmons.customer-consent.v1:" + prefix)
        .digest("base64url")
    );
  };
  it("has no default keys or environment fallback", () => {
    expect(() =>
      new CustomerConsentCredentials().issueSession(scope, now),
    ).toThrow("unavailable");
    expect(() =>
      new CustomerConsentCredentials().verifySession("any", now),
    ).toThrow("unavailable");
  });
  it.each([0, 16, 31, 33])("refuses a %s-byte signing key", (length) => {
    expect(
      () =>
        new CustomerConsentCredentials({
          activeKeyId: "fixture1",
          keys: { fixture1: Buffer.alloc(length) },
        }),
    ).toThrow();
  });
  it("issues random purpose-bound sessions without mailbox claims", () => {
    const c = model(),
      a = c.issueSession(scope, now),
      b = c.issueSession(scope, now);
    expect(a).not.toBe(b);
    expect(c.verifySession(a, now)).toMatchObject({
      ...scope,
      purpose: "customer-consent-session",
      expiresAt: now + CONSENT_SESSION_MS,
    });
  });
  it("refuses exact expiry, past expiry and future issuance", () => {
    const c = model(),
      token = c.issueSession(scope, now);
    expect(() =>
      c.verifySession(token, now + CONSENT_SESSION_MS - 1),
    ).not.toThrow();
    for (const time of [
      now - 1,
      now + CONSENT_SESSION_MS,
      now + CONSENT_SESSION_MS + 1,
    ])
      expect(() => c.verifySession(token, time)).toThrow("invalid or expired");
  });
  it("binds prompt to exact session, digest, prompt version and short deadline", () => {
    const c = model(),
      session = c.issueSession(scope, now);
    const token = c.issuePrompt(session, "a".repeat(64), 0, now);
    expect(c.verifyPrompt(token, session, now)).toMatchObject({
      mailboxDigest: "a".repeat(64),
      promptDigest: CONSENT_PROMPT_DIGEST,
      expectedRevision: 0,
      expiresAt: now + CONSENT_PROMPT_MS,
    });
    expect(() => c.verifySession(token, now)).toThrow();
    expect(() => c.verifyPrompt(session, session, now)).toThrow();
    expect(() =>
      c.verifyPrompt(token, c.issueSession(scope, now), now),
    ).toThrow();
    expect(() =>
      c.verifyPrompt(token, session, now + CONSENT_PROMPT_MS),
    ).toThrow();
  });
  it("caps prompt deadline at the original session expiry without renewal", () => {
    const c = model(),
      session = c.issueSession(scope, now),
      late = now + CONSENT_SESSION_MS - 1000;
    const token = c.issuePrompt(session, "a".repeat(64), 0, late);
    expect(c.verifyPrompt(token, session, late).expiresAt).toBe(
      now + CONSENT_SESSION_MS,
    );
  });
  it.each(["", "invalid", "key.payload.signature", "x".repeat(4097)])(
    "refuses malformed tokens %#",
    (token) => {
      expect(() => model().verifySession(token, now)).toThrow(
        "invalid or expired",
      );
    },
  );
  it("rejects tampering, trailing segments, unknown key and wrong signature", () => {
    const c = model(),
      token = c.issueSession(scope, now),
      [id, payload, sig] = token.split(".");
    for (const bad of [
      token + ".extra",
      "other." + payload + "." + sig,
      id + "." + payload + "." + sig.slice(0, -1) + "!",
      id + "." + payload + "." + Buffer.alloc(32).toString("base64url"),
    ])
      expect(() => c.verifySession(bad, now)).toThrow("invalid or expired");
  });
  it.each([
    { purpose: "appointment-management" },
    { v: 2 },
    { tenantId: "other" },
    { expiresAt: now + CONSENT_SESSION_MS + 1 },
    { issuedAt: now + 1 },
    { expiresAt: now },
    { issuedAt: 1.5 },
    { admin: true },
    { sessionId: "caller-selected" },
  ])("rejects signed but invalid claim shape %#", (change) => {
    const c = model(),
      claims = c.verifySession(c.issueSession(scope, now), now);
    expect(() =>
      c.verifySession(signed({ ...claims, ...change }), now),
    ).toThrow("invalid or expired");
  });
  it("supports bounded key overlap and refuses retired keys without a fallback", () => {
    const old = model(),
      token = old.issueSession(scope, now);
    const overlap = new CustomerConsentCredentials({
      activeKeyId: "fixture2",
      keys: { fixture1: key, fixture2: other },
    });
    expect(overlap.verifySession(token, now)).toBeDefined();
    expect(overlap.issueSession(scope, now)).toMatch(/^fixture2\./);
    const retired = new CustomerConsentCredentials({
      activeKeyId: "fixture2",
      keys: { fixture2: other },
    });
    expect(() => retired.verifySession(token, now)).toThrow();
  });
  it("copies keys and rejects malformed keyring configuration", () => {
    const mutable = Buffer.alloc(32, 9),
      c = new CustomerConsentCredentials({
        activeKeyId: "copy",
        keys: { copy: mutable },
      });
    const token = c.issueSession(scope, now);
    mutable.fill(0);
    expect(c.verifySession(token, now)).toBeDefined();
    expect(
      () =>
        new CustomerConsentCredentials({
          activeKeyId: "missing",
          keys: { fixture1: key },
        }),
    ).toThrow();
    expect(
      () =>
        new CustomerConsentCredentials({
          activeKeyId: "a",
          keys: { a: key, b: key, c: key },
        }),
    ).toThrow();
  });
});
