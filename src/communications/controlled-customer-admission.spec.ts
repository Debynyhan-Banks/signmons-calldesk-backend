import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  ControlledCustomerAdmission,
  controlledCustomerAdmissionDigest,
} from "./controlled-customer-admission";
describe("controlled phone admission configuration", () => {
  const policy = () => ({
    packetId: randomUUID(),
    tenantId: randomUUID(),
    accountSid: "AC" + "a".repeat(32),
    serviceSid: "VA" + "b".repeat(32),
    participantHmac: "c".repeat(64),
    noticeVersion: "v1",
    rateVersion: "synthetic",
    startsAt: Date.now() - 1000,
    expiresAt: Date.now() + 60000,
    flowUpperBoundMicros: 10,
    accountCeilingMicros: 20,
  });
  it("defaults closed and rejects invalid configuration before database use", async () => {
    const query = jest.fn();
    const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    await expect(
      new ControlledCustomerAdmission().lock(tx, randomUUID()),
    ).rejects.toThrow();
    for (const change of [
      { flowUpperBoundMicros: 0 },
      { accountCeilingMicros: 1 },
      { participantHmac: "phone" },
      { noticeVersion: "" },
      { packetId: "bad" },
      { extra: true },
    ]) {
      const p = { ...policy(), ...change };
      await expect(
        new ControlledCustomerAdmission(p).lock(tx, p.tenantId),
      ).rejects.toThrow();
    }
    expect(query).not.toHaveBeenCalled();
  });
  it("digests are order independent and bind ceilings and participant", () => {
    const p = policy();
    expect(controlledCustomerAdmissionDigest(p)).toBe(
      controlledCustomerAdmissionDigest({ ...p }),
    );
    expect(controlledCustomerAdmissionDigest(p)).not.toBe(
      controlledCustomerAdmissionDigest({ ...p, accountCeilingMicros: 21 }),
    );
  });
});
