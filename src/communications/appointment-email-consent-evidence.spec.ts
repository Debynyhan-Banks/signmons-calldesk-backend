import { Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AppointmentEmailConsentEvidenceStore,
  parseEmailConsentReceipt,
} from "./appointment-email-consent-evidence";
const receipt = () => ({
  version: 1,
  purpose: "APPOINTMENT_UPDATES_V1",
  promptVersion: "APPOINTMENT_EMAIL_OPT_IN_V1",
  sessionId: "session",
  response: "GRANTED",
  interactionId: "11111111-1111-4111-8111-111111111111",
  expectedRevision: 0,
});
describe("inactive email consent evidence boundary", () => {
  it.each(["GRANTED", "DECLINED", "REVOKED"])(
    "parses explicit %s evidence, not permission",
    (response) => {
      expect(
        parseEmailConsentReceipt({ ...receipt(), response }).decision,
      ).toBe(response);
    },
  );
  it.each([
    null,
    {},
    true,
    "yes",
    { consent: true },
    { ...receipt(), version: 2 },
    { ...receipt(), purpose: "MARKETING" },
    { ...receipt(), promptVersion: "address-only" },
    { ...receipt(), response: "yes" },
    { ...receipt(), response: true },
    { ...receipt(), sessionId: "" },
    { ...receipt(), sessionId: "x".repeat(65) },
    { ...receipt(), interactionId: "not-uuid" },
    { ...receipt(), expectedRevision: -1 },
    { ...receipt(), expectedRevision: 1.5 },
    { ...receipt(), expectedRevision: 2147483647 },
    { ...receipt(), email: "private@example.invalid" },
    { ...receipt(), verified: true },
    { ...receipt(), timestamp: "2030-01-01" },
  ])("refuses malformed, inferred or overridden authority %#", (value) => {
    expect(() => parseEmailConsentReceipt(value)).toThrow("needs review");
  });
  const input = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    conversationId: "22222222-2222-4222-8222-222222222222",
    sourceAuditId: "33333333-3333-4333-8333-333333333333",
  };
  const query = jest.fn();
  const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
  beforeEach(() => query.mockReset());
  it("has no default fingerprint authority and refuses before database access", async () => {
    await expect(
      new AppointmentEmailConsentEvidenceStore({ decrypt: () => null }).record(
        tx,
        input,
      ),
    ).rejects.toThrow("authority is unavailable");
    expect(query).not.toHaveBeenCalled();
  });
  it.each(["tenantId", "conversationId", "sourceAuditId"])(
    "rejects malformed %s before query",
    async (key) => {
      await expect(
        new AppointmentEmailConsentEvidenceStore({
          decrypt: () => null,
        }).record(tx, { ...input, [key]: "bad" }),
      ).rejects.toThrow("needs review");
      expect(query).not.toHaveBeenCalled();
    },
  );
  it("rejects injected record and binding overrides", async () => {
    const store = new AppointmentEmailConsentEvidenceStore({
      decrypt: () => null,
    });
    await expect(
      store.record(tx, { ...input, consent: true } as typeof input),
    ).rejects.toThrow("needs review");
    await expect(
      store.bindJob(tx, {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        jobId: input.sourceAuditId,
        verified: true,
      } as Parameters<typeof store.bindJob>[1]),
    ).rejects.toThrow("needs review");
    expect(query).not.toHaveBeenCalled();
  });
  it("sanitizes persistence errors", async () => {
    query.mockRejectedValue(
      new Error("private@example.invalid secret database detail"),
    );
    const store = new AppointmentEmailConsentEvidenceStore(
      { decrypt: () => null },
      {
        fingerprint: () => ({ digest: "a".repeat(64), keyVersion: "fixture" }),
      },
    );
    await expect(store.record(tx, input)).rejects.toThrow(
      "Email consent evidence outcome is unconfirmed.",
    );
    await expect(
      store.bindJob(tx, {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        jobId: input.sourceAuditId,
      }),
    ).rejects.toThrow("Email consent binding outcome is unconfirmed.");
  });
  it("remains unregistered and leaves positive eligibility unavailable", () => {
    const module = readFileSync(
      join(__dirname, "communications.module.ts"),
      "utf8",
    );
    expect(module).not.toContain("AppointmentEmailConsentEvidenceStore");
    const diagnostic = readFileSync(
      join(__dirname, "appointment-email-eligibility.service.ts"),
      "utf8",
    );
    expect(diagnostic).not.toContain("appointment-email-consent-evidence");
    expect(diagnostic).toContain("CONSENT_AUTHORITY_UNAVAILABLE");
  });
});
