import { createHash, randomUUID } from "node:crypto";
import { GoogleCorrectionContinuation } from "./google-correction-continuation";

describe("encrypted Google correction continuation", () => {
  let clock = Date.now();
  const stored = new Map<string, string>();
  const cipher = {
    encrypt: (value: string) => {
      const token =
        "v1." +
        createHash("sha256").update(value).digest("base64url") +
        ".opaque";
      stored.set(token, value);
      return token;
    },
    decrypt: (token: string) => stored.get(token) ?? null,
  };
  const binding = () => ({
    tenantId: randomUUID(),
    sessionId: randomUUID(),
    conversationId: randomUUID(),
    serviceCategoryId: randomUUID(),
    revision: 1,
    policyVersion: "controlled-v1",
    organizationApprovedAt: new Date(clock - 1000).toISOString(),
  });
  const responseId = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    clock = Date.now();
    stored.clear();
  });

  it("opens on a fresh instance without exposing the provider response ID", () => {
    const expected = binding();
    const token = new GoogleCorrectionContinuation(cipher, () => clock).issue(
      responseId,
      expected,
      clock + 600000,
    );
    expect(token).toMatch(/^v1\./);
    expect(token).not.toContain(responseId);
    expect(
      new GoogleCorrectionContinuation(cipher, () => clock).open(
        token,
        expected,
        clock + 600000,
      ),
    ).toBe(responseId);
  });

  it.each([
    "tenantId",
    "sessionId",
    "conversationId",
    "serviceCategoryId",
  ] as const)("refuses a foreign %s", (key) => {
    const expected = binding();
    const token = new GoogleCorrectionContinuation(cipher, () => clock).issue(
      responseId,
      expected,
      clock + 600000,
    );
    expect(
      new GoogleCorrectionContinuation(cipher, () => clock).open(
        token,
        { ...expected, [key]: randomUUID() },
        clock + 600000,
      ),
    ).toBeUndefined();
  });

  it("refuses changed revision, policy, organization and malformed ciphertext", () => {
    const expected = binding();
    const codec = new GoogleCorrectionContinuation(cipher, () => clock);
    const token = codec.issue(responseId, expected, clock + 600000);
    for (const patch of [
      { revision: 2 },
      { policyVersion: "changed" },
      { organizationApprovedAt: new Date(clock - 2000).toISOString() },
    ])
      expect(
        codec.open(token, { ...expected, ...patch }, clock + 600000),
      ).toBeUndefined();
    expect(
      codec.open("v1." + "x".repeat(80), expected, clock + 600000),
    ).toBeUndefined();
  });

  it("expires at the shorter five-minute or session boundary", () => {
    const expected = binding();
    const codec = new GoogleCorrectionContinuation(cipher, () => clock);
    const sessionExpiry = clock + 1000;
    const token = codec.issue(responseId, expected, sessionExpiry);
    clock = sessionExpiry;
    expect(codec.open(token, expected, sessionExpiry)).toBeUndefined();
  });

  it("refuses invalid IDs, bindings and oversized cipher output", () => {
    const expected = binding();
    expect(
      new GoogleCorrectionContinuation(cipher, () => clock).issue(
        "not-a-provider-id",
        expected,
        clock + 1000,
      ),
    ).toBeUndefined();
    expect(
      new GoogleCorrectionContinuation(
        { encrypt: () => "v1." + "a".repeat(5000), decrypt: () => null },
        () => clock,
      ).issue(responseId, expected, clock + 1000),
    ).toBeUndefined();
  });
});
