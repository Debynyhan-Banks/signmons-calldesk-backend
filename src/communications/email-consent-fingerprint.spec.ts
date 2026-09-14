import { createHmac } from "node:crypto";
import { DedicatedEmailConsentFingerprint } from "./email-consent-fingerprint";

const tenant = "11111111-1111-4111-8111-111111111111";
const mailbox = "Consent+Case@example.invalid";
describe("dedicated email consent fingerprint", () => {
  const adapter = (keyVersion = "v1", key = Buffer.alloc(32, 6)) =>
    new DedicatedEmailConsentFingerprint({ keyVersion, key });
  it("matches the versioned purpose-separated deterministic serialization", () => {
    const a = adapter();
    const result = a.fingerprint(tenant, mailbox);
    expect(result).toEqual({
      keyVersion: "v1",
      digest: createHmac("sha256", Buffer.alloc(32, 6))
        .update(
          JSON.stringify([
            "signmons.email-consent.fingerprint.v1",
            "v1",
            tenant,
            mailbox,
          ]),
        )
        .digest("hex"),
    });
    expect(a.fingerprint(tenant, mailbox)).toEqual(result);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.digest).not.toBe(
      createHmac("sha256", Buffer.alloc(32, 6))
        .update(JSON.stringify([tenant, mailbox]))
        .digest("hex"),
    );
  });
  it("separates tenant, version, key and local-part semantics without rewriting old results", () => {
    const a = adapter();
    const old = a.fingerprint(tenant, mailbox);
    for (const result of [
      a.fingerprint("22222222-2222-4222-8222-222222222222", mailbox),
      a.fingerprint(tenant, "consent+Case@example.invalid"),
      a.fingerprint(tenant, "Consent@example.invalid"),
      adapter("v2").fingerprint(tenant, mailbox),
      adapter("v1", Buffer.alloc(32, 7)).fingerprint(tenant, mailbox),
    ])
      expect(result.digest).not.toBe(old.digest);
    expect(old).toEqual(a.fingerprint(tenant, mailbox));
  });
  it("copies key material, exposes none through serialization and retires without fallback", () => {
    const key = Buffer.alloc(32, 6);
    const a = adapter("v1", key);
    const prior = a.fingerprint(tenant, mailbox);
    key.fill(0);
    expect(a.fingerprint(tenant, mailbox)).toEqual(prior);
    expect(JSON.stringify(a)).toBe("{}");
    a.retire();
    a.retire();
    expect(() => a.fingerprint(tenant, mailbox)).toThrow("unavailable");
    expect(prior.keyVersion).toBe("v1");
  });
  it("refuses absent or malformed authority and noncanonical input", () => {
    expect(() =>
      new DedicatedEmailConsentFingerprint().fingerprint(tenant, mailbox),
    ).toThrow("unavailable");
    for (const key of [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33)])
      expect(() => adapter("v1", key)).toThrow("unavailable");
    for (const version of ["", "v 1", "x".repeat(33)])
      expect(() => adapter(version)).toThrow("unavailable");
    for (const value of [
      "",
      "not-mail",
      "Consent+Case@EXAMPLE.INVALID",
      " Consent+Case@example.invalid",
      "Consent+Case@example.invalid\n",
    ])
      expect(() => adapter().fingerprint(tenant, value)).toThrow("unavailable");
    expect(() => adapter().fingerprint("wrong", mailbox)).toThrow(
      "unavailable",
    );
  });
});
