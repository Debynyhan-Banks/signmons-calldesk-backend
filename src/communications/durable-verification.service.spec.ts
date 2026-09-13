/* eslint-disable @typescript-eslint/require-await -- Async transaction mocks. */
import { randomUUID } from "node:crypto";
import { DurableVerificationService } from "./durable-verification.service";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import {
  TwilioVerifyAdapter,
  VerifyAdapterResult,
} from "./twilio-verify.adapter";

describe("durable verification operation", () => {
  let stored: string | null,
    audits: Record<string, unknown>[],
    fail: string,
    inTx: boolean,
    active: boolean;
  let service: DurableVerificationService,
    adapter: { start: jest.Mock; check: jest.Mock };
  let admission: { lock: jest.Mock; reserve: jest.Mock; check: jest.Mock };
  const scope = {
    tenantId: randomUUID(),
    conversationId: randomUUID(),
    sessionId: randomUUID(),
  };
  const credentials = {
    verifySession: (token: string) => {
      if (token !== "fixture") throw Error("bad token");
      return scope;
    },
  } as CustomerConsentCredentials;
  const cipher = {
    encrypt: (s: string) => Buffer.from(s).toString("base64"),
    decrypt: (s: string) => Buffer.from(s, "base64").toString(),
  } as ConversationMemoryCipher;
  const request = () => ({
    sessionToken: "fixture",
    operationId: randomUUID(),
    kind: "START",
    phone: "+12025550123",
    code: "",
    startOperationId: "",
  });
  const check = (start: string) => ({
    ...request(),
    kind: "CHECK",
    code: "123456",
    startOperationId: start,
  });
  const result = (
    id: string,
    operation: "START" | "CHECK",
    outcome: "PENDING" | "APPROVED" = "PENDING",
  ): VerifyAdapterResult => ({
    operationId: id,
    outcome,
    verificationSid: "VE" + "a".repeat(32),
    usage: { operation, sdkInvocations: 1, billing: "UNRECONCILED" },
    phoneAccessAuthorized: false,
    bookingAuthorized: false,
    deliveryAuthorized: false,
  });
  beforeEach(() => {
    stored = null;
    audits = [];
    fail = "";
    inTx = false;
    active = true;
    const tx = {
      $queryRaw: async (q: { strings: string[] }) => {
        const sql = q.strings.join("");
        if (sql.includes("AS value")) return [{ value: stored }];
        if (sql.includes("SELECT c.status"))
          return [
            {
              sessionId: scope.sessionId,
              marker: 1,
              status: active ? "ONGOING" : "CLOSED",
            },
          ];
        return [{ id: scope.tenantId }];
      },
      $executeRaw: async (q: { values: unknown[] }) => {
        stored = JSON.parse(q.values[0] as string) as string;
        return 1;
      },
      auditLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (data.action === fail) throw Error("audit failure");
          audits.push(data);
          return data;
        },
      },
    };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
        const before = stored,
          length = audits.length;
        inTx = true;
        try {
          return await fn(tx);
        } catch (e) {
          stored = before;
          audits.length = length;
          throw e;
        } finally {
          inTx = false;
        }
      },
    } as unknown as PrismaService;
    adapter = {
      start: jest.fn(async (input: Record<string, unknown>) => {
        expect(inTx).toBe(false);
        return result(input.operationId as string, "START");
      }),
      check: jest.fn(async (input: Record<string, unknown>) => {
        expect(inTx).toBe(false);
        return result(input.operationId as string, "CHECK", "APPROVED");
      }),
    };
    admission = {
      lock: jest.fn(async () => {}),
      reserve: jest.fn(async () => {}),
      check: jest.fn(async () => {}),
    };
    service = new DurableVerificationService(
      prisma,
      cipher,
      credentials,
      Buffer.alloc(32, 9),
      adapter as Pick<TwilioVerifyAdapter, "start" | "check">,
      admission,
    );
  });
  it("refuses a rejected admission before provider invocation or operation writes", async () => {
    admission.reserve.mockRejectedValue(Error("budget unavailable"));
    await expect(service.execute(request())).rejects.toThrow();
    expect(adapter.start).not.toHaveBeenCalled();
    expect(stored).toBeNull();
    expect(audits).toHaveLength(0);
  });
  it("replays without reserving twice and refuses missing check authority", async () => {
    const start = request();
    await service.execute(start);
    await service.execute(start);
    expect(admission.reserve).toHaveBeenCalledTimes(1);
    admission.check.mockRejectedValue(Error("no budget authority"));
    await expect(service.execute(check(start.operationId))).rejects.toThrow();
    expect(adapter.check).not.toHaveBeenCalled();
  });
  it("reserves before call, finalizes once, replays without duplicate usage", async () => {
    const input = request(),
      first = await service.execute(input);
    expect(first).toMatchObject({
      state: "OBSERVED",
      outcome: "PENDING",
      usage: { sdkInvocations: 1, billing: "UNRECONCILED" },
    });
    const saved = stored;
    expect(await service.execute(input)).toEqual(first);
    expect(stored).toBe(saved);
    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(audits).toHaveLength(2);
  });
  it("derives check SID from saved start and never grants authority", async () => {
    const start = request();
    await service.execute(start);
    const input = check(start.operationId);
    const receipt = await service.execute(input);
    expect(adapter.check).toHaveBeenCalledWith({
      tenantId: scope.tenantId,
      operationId: input.operationId,
      phone: input.phone,
      code: "123456",
      verificationSid: "VE" + "a".repeat(32),
    });
    expect(receipt).toMatchObject({
      outcome: "APPROVED",
      phoneAccessAuthorized: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    });
    expect(await service.execute(input)).toEqual(receipt);
    expect(adapter.check).toHaveBeenCalledTimes(1);
    await expect(service.execute(check(start.operationId))).rejects.toThrow();
  });
  it("rolls back failed reservation audit before any invocation", async () => {
    fail = "conversation.verification_reserved";
    await expect(service.execute(request())).rejects.toThrow("unconfirmed");
    expect(stored).toBeNull();
    expect(adapter.start).not.toHaveBeenCalled();
  });
  it("failed finalization preserves potential cost and never reissues call", async () => {
    fail = "conversation.verification_observed";
    const input = request();
    const receipt = await service.execute(input);
    expect(receipt).toMatchObject({
      state: "UNCONFIRMED",
      usage: { sdkInvocations: null, billing: "UNRECONCILED" },
    });
    fail = "";
    expect(await service.execute(input)).toEqual(receipt);
    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(audits).toHaveLength(1);
    await expect(service.execute(request())).rejects.toThrow();
  });
  it("does not collapse timeout into free/failed or retry automatically", async () => {
    adapter.start.mockRejectedValue(Error("private payload"));
    const input = request();
    expect(await service.execute(input)).toMatchObject({
      outcome: "UNKNOWN",
      usage: { billing: "UNRECONCILED" },
    });
    await service.execute(input);
    expect(adapter.start).toHaveBeenCalledTimes(1);
  });
  it.each([{ phone: "+12025550124" }, { code: "000000" }])(
    "rejects changed retry %j",
    async (patch) => {
      const start = request();
      await service.execute(start);
      const input = check(start.operationId);
      await service.execute(input);
      await expect(service.execute({ ...input, ...patch })).rejects.toThrow();
      expect(adapter.check).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses orphan check, new start, changed phone and closed session", async () => {
    await expect(service.execute(check(randomUUID()))).rejects.toThrow();
    const input = request();
    await service.execute(input);
    await expect(service.execute(request())).rejects.toThrow();
    await expect(
      service.execute({ ...check(input.operationId), phone: "+12025550124" }),
    ).rejects.toThrow();
    active = false;
    await expect(service.execute(input)).rejects.toThrow();
  });
  it("bounds checks to five", async () => {
    const start = request();
    await service.execute(start);
    adapter.check.mockImplementation(async (input: Record<string, unknown>) =>
      result(input.operationId as string, "CHECK"),
    );
    for (let i = 0; i < 5; i++) await service.execute(check(start.operationId));
    await expect(service.execute(check(start.operationId))).rejects.toThrow();
    expect(adapter.check).toHaveBeenCalledTimes(5);
  });
  it("sanitizes invalid adapter result and does not persist code in ledger/audit", async () => {
    adapter.start.mockResolvedValue({
      secret: "123456",
      phone: "+12025550123",
    });
    const input = request();
    const receipt = await service.execute(input);
    expect(receipt.outcome).toBe("UNKNOWN");
    expect(JSON.stringify(receipt)).not.toMatch(/123456|202555/);
    expect(cipher.decrypt(stored!)).not.toMatch(/123456|202555/);
    expect(JSON.stringify(audits)).not.toMatch(/123456|202555/);
  });
  it.each([
    { extra: true },
    { kind: "bad" },
    { kind: ["START"] },
    { phone: "123" },
    { operationId: "bad" },
    { startOperationId: randomUUID() },
    { code: "123456" },
    { sessionToken: "bad" },
  ])("refuses invalid input %j", async (patch) => {
    await expect(service.execute({ ...request(), ...patch })).rejects.toThrow();
    expect(adapter.start).not.toHaveBeenCalled();
  });
});
