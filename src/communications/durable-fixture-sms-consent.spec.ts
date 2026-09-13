import { randomUUID } from "node:crypto";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { DurableFixtureSmsConsent } from "./durable-fixture-sms-consent";
import { fixtureSmsPolicy } from "./fixture-sms-policy";
import { PrismaService } from "../prisma/prisma.service";

describe("durable fixture SMS boundary", () => {
  const credentials = new CustomerConsentCredentials({
    activeKeyId: "test",
    keys: { test: Buffer.alloc(32, 7) },
  });
  const token = credentials.issueSession({
    tenantId: randomUUID(),
    conversationId: randomUUID(),
    sessionId: randomUUID(),
  });
  const transaction = jest.fn();
  const model = () =>
    new DurableFixtureSmsConsent(
      { $transaction: transaction } as unknown as PrismaService,
      { encrypt: (v) => v, decrypt: (v) => v },
      credentials,
    );
  const input = {
    sessionToken: token,
    action: "PROMPT",
    phone: "+12025550123",
    promptId: "",
    accepted: false,
  };
  beforeEach(() => transaction.mockReset());
  it.each([
    { accepted: "yes" },
    { phone: "2165551234" },
    { tenantId: randomUUID() },
    { action: "SEND" },
    { action: "CAPTURE", promptId: "unsafe" },
    { accepted: true },
  ])("rejects malformed input before database access %j", async (changed) => {
    await expect(model().handle({ ...input, ...changed })).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it("masks database errors and never reports a confirmed capture", async () => {
    transaction.mockRejectedValue(new Error("private database details"));
    await expect(model().handle(input)).rejects.toThrow("outcome unconfirmed");
  });
  it.each([
    null,
    {},
    { fixtureOnly: false },
    { fixtureOnly: true, active: false },
  ])("refuses unavailable source %j", (source) => {
    expect(() =>
      fixtureSmsPolicy(source, credentials.verifySession(token), input.phone),
    ).toThrow("unavailable");
  });
});
