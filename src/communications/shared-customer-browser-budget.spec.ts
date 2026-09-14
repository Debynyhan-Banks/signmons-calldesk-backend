import { randomUUID } from "node:crypto";
import { SharedCustomerBrowserBudget } from "./shared-customer-browser-budget";
describe("shared browser budget closed boundaries", () => {
  it("contains release failures and refuses session binding on database loss", async () => {
    const transaction = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValue(Error("offline"));
    const budget = new SharedCustomerBrowserBudget(
      { $transaction: transaction },
      policy(),
    );
    const lease = await budget.acquire("ignored", "verify");
    expect(lease).not.toBeNull();
    expect(await lease!.bindSession!(randomUUID())).toBe(false);
    await expect(Promise.resolve(lease!())).resolves.toBeUndefined();
  });
  const policy = () => ({
    packetId: randomUUID(),
    tenantId: randomUUID(),
    validFrom: Date.now() - 1000,
    validUntil: Date.now() + 60000,
    total: 10,
    tenant: 10,
    session: 5,
    starts: 1,
    inFlight: 2,
  });
  it("refuses missing/malformed policy and database failure", async () => {
    const transaction = jest
      .fn()
      .mockRejectedValue(Error("private database error"));
    const db = { $transaction: transaction };
    expect(
      await new SharedCustomerBrowserBudget(db).acquire("ignored", "start"),
    ).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
    expect(
      await new SharedCustomerBrowserBudget(db, {
        ...policy(),
        total: -1,
      }).acquire("ignored", "start"),
    ).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
    expect(
      await new SharedCustomerBrowserBudget(db, policy()).acquire(
        "ignored",
        "start",
      ),
    ).toBeNull();
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
