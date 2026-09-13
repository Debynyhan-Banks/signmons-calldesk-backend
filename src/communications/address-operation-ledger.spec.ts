import { randomUUID } from "node:crypto";
import { AddressOperationLedger } from "./address-operation-ledger";
import { CustomerConsentCredentials } from "./customer-consent-credentials";

describe("disabled address operation ledger", () => {
  const credentials = new CustomerConsentCredentials({
    activeKeyId: "test",
    keys: { test: Buffer.alloc(32, 7) },
  });
  const token = credentials.issueSession({
    tenantId: randomUUID(),
    conversationId: randomUUID(),
    sessionId: randomUUID(),
  });
  const request = {
    sessionToken: token,
    requestId: randomUUID(),
    action: "reserve" as const,
  };
  it("refuses default construction before database access", async () => {
    const $transaction = jest.fn();
    await expect(
      new AddressOperationLedger({ $transaction }, credentials).execute(
        request,
      ),
    ).rejects.toThrow();
    expect($transaction).not.toHaveBeenCalled();
  });
  it.each([
    { ...request, address: "private street" },
    { ...request, requestId: "invalid" },
    { ...request, action: "send" },
    { ...request, sessionToken: "x".repeat(4097) },
  ])(
    "refuses malformed or expanded input before persistence",
    async (input) => {
      const $transaction = jest.fn();
      const service = new AddressOperationLedger(
        { $transaction },
        credentials,
        { accountId: randomUUID(), readBinding: jest.fn() },
      );
      await expect(service.execute(input as typeof request)).rejects.toThrow();
      expect($transaction).not.toHaveBeenCalled();
    },
  );
  it("valid credentials without trusted integration context refuse", async () => {
    const $transaction = jest.fn();
    const service = new AddressOperationLedger({ $transaction }, credentials, {
      accountId: randomUUID(),
      readBinding: jest.fn(),
    });
    await expect(service.execute(request)).rejects.toThrow();
    expect($transaction).not.toHaveBeenCalled();
  });
});
