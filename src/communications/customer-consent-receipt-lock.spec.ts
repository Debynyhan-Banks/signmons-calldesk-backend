import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { lockCustomerConsentReceipt } from "./customer-consent-session-lock";
jest.mock("../conversations/conversation-session-lock", () => ({
  lockConversationSession: jest.fn(),
}));

describe("credential-valid receipt-only lock", () => {
  const credentials = new CustomerConsentCredentials({
    activeKeyId: "fixture",
    keys: { fixture: Buffer.alloc(32, 4) },
  });
  const scope = {
    tenantId: randomUUID(),
    conversationId: randomUUID(),
    sessionId: randomUUID(),
  };
  function fixture() {
    const token = credentials.issueSession(scope);
    const claims = credentials.verifySession(token);
    const row = {
      sessionId: scope.sessionId,
      marker: 1,
      status: "COMPLETED",
      hasLifecycle: false,
      nowMs: BigInt(Date.now()),
    };
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: scope.tenantId }])
      .mockImplementation(() => Promise.resolve([row]));
    return {
      token,
      claims,
      row,
      query,
      tx: { $queryRaw: query } as unknown as Prisma.TransactionClient,
    };
  }
  it("allows a still-authenticated completed-session receipt without issuing credentials", async () => {
    const f = fixture();
    expect(await lockCustomerConsentReceipt(f.tx, f.token, credentials)).toBe(
      f.row,
    );
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it("rejects forged credentials before database access", async () => {
    const f = fixture();
    await expect(
      lockCustomerConsentReceipt(f.tx, "forged", credentials),
    ).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
  it("rejects credentials expired according to database time", async () => {
    const f = fixture();
    f.row.nowMs = BigInt(f.claims.expiresAt);
    await expect(
      lockCustomerConsentReceipt(f.tx, f.token, credentials),
    ).rejects.toThrow();
  });
  it("rejects a foreign conversation-session binding", async () => {
    const f = fixture();
    f.row.sessionId = randomUUID();
    await expect(
      lockCustomerConsentReceipt(f.tx, f.token, credentials),
    ).rejects.toThrow();
  });
  it("refuses missing active tenant", async () => {
    const f = fixture();
    f.query.mockReset().mockResolvedValue([]);
    await expect(
      lockCustomerConsentReceipt(f.tx, f.token, credentials),
    ).rejects.toThrow();
  });
  it("does not treat a malformed lifecycle as a valid historical record", async () => {
    const f = fixture();
    f.row.hasLifecycle = true;
    await expect(
      lockCustomerConsentReceipt(f.tx, f.token, credentials),
    ).rejects.toThrow();
  });
});
