import { createHmac } from "node:crypto";
import { smsConsentPhoneHash } from "./sms-consent-recipient";

describe("SMS consent hash compatibility", () => {
  it("preserves the exact existing hash and separates tenants", () => {
    const hash = smsConsentPhoneHash("fixture-key", "tenant-a", "+12165550183");
    expect(hash).toBe(
      createHmac("sha256", "fixture-key")
        .update("tenant-a:+12165550183")
        .digest("hex"),
    );
    expect(hash).not.toBe(
      smsConsentPhoneHash("fixture-key", "tenant-b", "+12165550183"),
    );
  });
  it("refuses missing keys and non-normalized phone numbers", () => {
    expect(() =>
      smsConsentPhoneHash(undefined, "tenant", "+12165550183"),
    ).toThrow("not configured");
    expect(() =>
      smsConsentPhoneHash("fixture", "tenant", "2165550183"),
    ).toThrow("invalid");
  });
});
