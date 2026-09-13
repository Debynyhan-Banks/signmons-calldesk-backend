import {
  validateSmsPolicy,
  smsPolicyDigest,
  policyRevision,
  policyReference,
} from "./tenant-sms-policy";
const urls = [
  "https://policy.example.invalid/privacy",
  "https://policy.example.invalid/terms",
];
const content = {
  legalSender: "Fictional Heating",
  purpose: "APPOINTMENT_UPDATES_V1",
  supportEmail: "support@example.invalid",
  disclosure: "Optional service texts. STOP to opt out.",
  disclosureVersion: "v1",
  privacyUrl: urls[0],
  privacyVersion: "v1",
  termsUrl: urls[1],
  termsVersion: "v1",
  effectiveAt: "2039-01-01T00:00:00.000Z",
  expiresAt: "2039-02-01T00:00:00.000Z",
};
describe("tenant SMS policy domain", () => {
  it("canonicalizes field order without changing public text", () => {
    const policy = validateSmsPolicy(content, urls);
    expect(policy).toEqual(content);
    expect(
      smsPolicyDigest(
        validateSmsPolicy(
          Object.fromEntries(Object.entries(content).reverse()),
          urls,
        ),
      ),
    ).toBe(smsPolicyDigest(policy));
  });
  it.each([
    "http://policy.example.invalid/privacy",
    "https://user:secret@policy.example.invalid/privacy",
    "https://policy.example.invalid/privacy?token=secret",
    "https://policy.example.invalid/privacy#private",
    "https://127.0.0.1/privacy",
    "https://policy.example.invalid/a/../privacy",
    "https://policy.example.invalid/%70rivacy",
    "javascript:alert(1)",
  ])("refuses unsafe/unapproved URL %s", (privacyUrl) => {
    expect(() =>
      validateSmsPolicy({ ...content, privacyUrl }, [...urls, privacyUrl]),
    ).toThrow();
  });
  it("refuses a foreign HTTPS URL unless explicitly allowlisted", () =>
    expect(() =>
      validateSmsPolicy(
        { ...content, privacyUrl: "https://foreign.invalid/privacy" },
        urls,
      ),
    ).toThrow());
  it.each([
    { purpose: "MARKETING" },
    { tenantId: "browser" },
    { legalSender: "" },
    { supportEmail: "invalid" },
    { disclosure: "secret\ntext" },
    { disclosureVersion: "x/y" },
    { expiresAt: content.effectiveAt },
    { effectiveAt: "2039-01-01" },
  ])("refuses malformed content %j", (change) =>
    expect(() => validateSmsPolicy({ ...content, ...change }, urls)).toThrow(),
  );
  it.each([-1, 1.5, 2147483647, "1", null])("rejects revision %j", (v) =>
    expect(() => policyRevision(v)).toThrow(),
  );
  it("requires a bounded opaque audit reference", () => {
    expect(policyReference("review-1")).toBe("review-1");
    expect(() =>
      policyReference("https://private.invalid/?key=secret"),
    ).toThrow();
  });
});
