import { randomUUID } from "node:crypto";
import { ControlledIntakeComposition } from "./controlled-intake-composition";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { CustomerIntakeContinuationService } from "./customer-intake-continuation.service";
import { ControlledIntakeAuthority } from "./controlled-intake-authority";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "@prisma/client";

describe("disabled controlled intake composition", () => {
  const tenantId = randomUUID();
  const credentials = new CustomerConsentCredentials({
    activeKeyId: "test",
    keys: { test: Buffer.alloc(32, 7) },
  });
  const input = () => ({
    version: 2,
    confirmed: true,
    requestId: randomUUID(),
    expectedRevision: 1,
    sessionToken: credentials.issueSession({
      tenantId,
      conversationId: randomUUID(),
      sessionId: randomUUID(),
    }),
    confirmedAddress: {
      street: "123 Fictional Lane",
      unit: "",
      city: "Example",
      postalCode: "44101",
    },
    draft: {
      customerName: "Fictional",
      phone: "+12025550123",
      address: "123 Fictional Lane, Example, OH 44101",
      description: "Cooling issue",
      issueCategory: "COOLING",
      propertyType: "RESIDENTIAL",
      serviceIntent: "REPAIR",
    },
  });
  const setup = () => {
    const submitControlled = jest.fn(),
      transaction = jest.fn(),
      readAddressPolicy = jest.fn(),
      validate = jest.fn(),
      readControlledCurrent = jest.fn();
    const capability = Object.freeze({});
    const authority = new ControlledIntakeAuthority(
      () => undefined,
      () => Promise.reject(Error("not configured")),
    );
    const composition = new ControlledIntakeComposition({
      prisma: { $transaction: transaction } as unknown as PrismaService,
      credentials,
      tenantId,
      integrationId: "test-integration",
      origin: "https://customer.example.invalid",
      intake: {
        submitControlled,
      } as unknown as CustomerIntakeContinuationService,
      authority,
      capability,
      phone: { readControlledCurrent },
      transport: { validate },
      addressAccountId: randomUUID(),
      readAddressPolicy,
    });
    return {
      composition,
      submitControlled,
      transaction,
      readAddressPolicy,
      validate,
      readControlledCurrent,
      capability,
      authority,
    };
  };
  it("refuses without server resources", async () => {
    await expect(
      new ControlledIntakeComposition().submit(input()),
    ).rejects.toThrow("unavailable");
  });
  it("validates input before delegating and never accepts browser authority", async () => {
    const s = setup();
    for (const change of [
      { version: 1 },
      { capability: {} },
      { tenantId },
      { confirmed: false },
    ])
      await expect(
        s.composition.submit({ ...input(), ...change }),
      ).rejects.toThrow();
    expect(s.submitControlled).not.toHaveBeenCalled();
    expect(s.transaction).not.toHaveBeenCalled();
  });
  it("refuses a foreign tenant before any transaction or provider", async () => {
    const s = setup();
    await expect(
      s.composition.submit({
        ...input(),
        sessionToken: credentials.issueSession({
          tenantId: randomUUID(),
          conversationId: randomUUID(),
          sessionId: randomUUID(),
        }),
      }),
    ).rejects.toThrow();
    expect(s.submitControlled).not.toHaveBeenCalled();
    expect(s.validate).not.toHaveBeenCalled();
  });
  it("delegates exact replay before constructing verification or reading policy", async () => {
    const s = setup(),
      v = input(),
      receipt = { status: "ADMITTED", jobId: randomUUID() };
    s.submitControlled.mockResolvedValue(receipt);
    expect(await s.composition.submit(v)).toBe(receipt);
    expect(s.submitControlled).toHaveBeenCalledWith(
      v,
      expect.objectContaining({
        authority: s.authority,
        capability: s.capability,
        origin: "https://customer.example.invalid",
        integrationId: "test-integration",
      }),
    );
    expect(s.transaction).not.toHaveBeenCalled();
    expect(s.readAddressPolicy).not.toHaveBeenCalled();
    expect(s.validate).not.toHaveBeenCalled();
    expect(s.readControlledCurrent).not.toHaveBeenCalled();
  });
  it("awaits current reader failure before constructing provider work", async () => {
    const s = setup();
    s.submitControlled.mockImplementation(
      (
        _input: unknown,
        binding: Parameters<
          CustomerIntakeContinuationService["submitControlled"]
        >[1],
      ) => binding.verification(jest.fn().mockRejectedValue(Error("stale"))),
    );
    s.transaction.mockImplementation(
      (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        fn({} as Prisma.TransactionClient),
    );
    await expect(s.composition.submit(input())).rejects.toThrow("stale");
    expect(s.validate).not.toHaveBeenCalled();
    expect(s.readControlledCurrent).not.toHaveBeenCalled();
    expect(s.readAddressPolicy).not.toHaveBeenCalled();
  });
});
