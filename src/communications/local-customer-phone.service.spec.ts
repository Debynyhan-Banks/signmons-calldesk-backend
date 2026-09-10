/* eslint-disable @typescript-eslint/require-await -- Transaction mocks preserve asynchronous interfaces. */
import { LocalCustomerPhoneService } from "./local-customer-phone.service";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { PrismaService } from "../prisma/prisma.service";
import { randomUUID } from "node:crypto";

describe("local phone fixture boundary", () => {
  let now: number, stored: string | null, failAudit: boolean, active: boolean;
  let service: LocalCustomerPhoneService;
  let audits: { action: string; metadata: Record<string, unknown> }[];
  const session = {
    tenantId: randomUUID(),
    conversationId: randomUUID(),
    sessionId: randomUUID(),
    expiresAt: Date.now() + 900000,
  };
  const credentials = {
    verifySession: (token: string) => {
      if (token !== "fixture") throw Error("invalid credential");
      return session;
    },
  } as CustomerConsentCredentials;
  const cipher = {
    encrypt: (s: string) => Buffer.from(s).toString("base64"),
    decrypt: (s: string) => Buffer.from(s, "base64").toString(),
  } as ConversationMemoryCipher;
  const body = (
    action = "request",
    revision = 0,
    phone = "+12025550123",
    code = "",
  ) => ({
    action,
    expectedRevision: revision,
    phone,
    code,
    sessionToken: "fixture",
    operationId: randomUUID(),
  });
  beforeEach(() => {
    now = Date.now();
    stored = null;
    failAudit = false;
    active = true;
    audits = [];
    const tx = {
      $queryRaw: jest.fn(async (q: { strings: string[] }) => {
        const sql = q.strings.join("");
        if (sql.includes("AS value")) return [{ value: stored }];
        if (sql.includes("SELECT c.status"))
          return [
            {
              sessionId: session.sessionId,
              marker: 1,
              status: active ? "ONGOING" : "CLOSED",
            },
          ];
        return [{ id: session.tenantId }];
      }),
      $executeRaw: jest.fn(async (q: { values: unknown[] }) => {
        stored = JSON.parse(q.values[0] as string) as string;
        return 1;
      }),
      auditLog: {
        count: jest.fn(
          async ({ where }: { where: { action: string } }) =>
            audits.filter((a) => a.action === where.action).length,
        ),
        create: jest.fn(async ({ data }: { data: (typeof audits)[number] }) => {
          if (failAudit) throw Error("audit failure");
          audits.push(data);
          return data;
        }),
      },
    };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
        const before = stored,
          length = audits.length;
        try {
          return await fn(tx);
        } catch (e) {
          stored = before;
          audits.length = length;
          throw e;
        }
      },
    } as unknown as PrismaService;
    service = new LocalCustomerPhoneService(
      prisma,
      cipher,
      credentials,
      Buffer.alloc(32, 7),
      () => now,
    );
  });
  it("requests once and repeats exact receipt without another write", async () => {
    const request = body();
    const first = await service.handle(request),
      saved = stored;
    expect(await service.handle(request)).toEqual(first);
    expect(stored).toBe(saved);
    expect(audits).toHaveLength(2);
    expect(first).toMatchObject({
      state: "PENDING",
      fixtureOnly: true,
      phoneAccessAuthorized: false,
    });
  });
  it("counts wrong code, accepts fixture code once, never grants authority", async () => {
    await service.handle(body());
    expect(
      await service.handle(body("check", 1, "+12025550123", "000000")),
    ).toMatchObject({ attemptsRemaining: 4, state: "PENDING" });
    const check = body("check", 2, "+12025550123", "123456");
    expect(await service.handle(check)).toMatchObject({
      state: "FIXTURE_VERIFIED",
      phoneAccessAuthorized: false,
      deliveryAuthorized: false,
      bookingAuthorized: false,
    });
    expect(await service.handle(check)).toMatchObject({ revision: 3 });
    await expect(
      service.handle(body("check", 3, "+12025550123", "123456")),
    ).rejects.toThrow();
  });
  it("clear invalidates proof, preserves limits and rejects stale checks", async () => {
    await service.handle(body());
    await service.handle(body("check", 1, "+12025550123", "123456"));
    expect(await service.handle(body("clear", 2, ""))).toMatchObject({
      state: "EMPTY",
      revision: 3,
    });
    await expect(
      service.handle(body("check", 2, "+12025550123", "123456")),
    ).rejects.toThrow();
    await expect(
      service.handle(body("request", 3, "+12025550124")),
    ).rejects.toThrow();
    now += 30001;
    expect(
      await service.handle(body("request", 3, "+12025550124")),
    ).toMatchObject({ state: "PENDING" });
  });
  it("caps attempts across resend, refuses exhausted verification", async () => {
    await service.handle(body());
    for (let n = 1; n <= 5; n++)
      await service.handle(body("check", n, "+12025550123", "000000"));
    await expect(
      service.handle(body("check", 6, "+12025550123", "123456")),
    ).rejects.toThrow();
    now += 30001;
    await expect(service.handle(body("request", 6))).rejects.toThrow();
  });
  it("expires a challenge and never replays stale success as current proof", async () => {
    await service.handle(body());
    const check = body("check", 1, "+12025550123", "123456");
    await service.handle(check);
    now += 600001;
    expect(await service.handle(check)).toMatchObject({ state: "EXPIRED" });
  });
  it("refuses expired code and early resend", async () => {
    await service.handle(body());
    await expect(service.handle(body("request", 1))).rejects.toThrow();
    now += 300001;
    await expect(
      service.handle(body("check", 1, "+12025550123", "123456")),
    ).rejects.toThrow();
  });
  it("rolls back failed audits and refuses inactive session", async () => {
    failAudit = true;
    await expect(service.handle(body())).rejects.toThrow();
    expect(stored).toBeNull();
    expect(audits).toHaveLength(0);
    failAudit = false;
    active = false;
    await expect(service.handle(body())).rejects.toThrow();
  });
  it("rejects changed operation reuse and wrong phone", async () => {
    const request = body();
    await service.handle(request);
    await expect(
      service.handle({ ...request, phone: "+12025550124" }),
    ).rejects.toThrow();
    await expect(
      service.handle(body("check", 1, "+12025550124", "123456")),
    ).rejects.toThrow();
  });
  it.each([
    { extra: true },
    { phone: "2025550123" },
    { phone: "+0" },
    { code: "123456" },
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { operationId: "bad" },
    { action: "approve" },
    { sessionToken: "bad" },
  ])("refuses invalid input %j", async (patch) => {
    await expect(service.handle({ ...body(), ...patch })).rejects.toThrow();
    expect(stored).toBeNull();
  });
  it("does not put phone/code in audits and keeps unrelated status reads write-free", async () => {
    await service.handle(body());
    const saved = stored,
      length = audits.length;
    await service.handle(body("status", 1, ""));
    expect(stored).toBe(saved);
    expect(audits).toHaveLength(length);
    expect(JSON.stringify(audits)).not.toContain("+12025550123");
    expect(JSON.stringify(audits)).not.toContain("123456");
  });
});
