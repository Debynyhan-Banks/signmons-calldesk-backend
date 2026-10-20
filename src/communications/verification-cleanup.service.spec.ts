import { VerificationCleanupService } from "./verification-cleanup.service";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { PrismaService } from "../prisma/prisma.service";
const tenantId = "11111111-1111-4111-8111-111111111111";
describe("controlled session cleanup scope", () => {
  it("copies the bound tenant and refuses foreign scope before database access", async () => {
    const query = jest.fn();
    const tx = { $queryRaw: query };
    const prisma = {
      $transaction: (fn: (v: unknown) => unknown) => Promise.resolve(fn(tx)),
    } as unknown as Pick<PrismaService, "$transaction">;
    const credentials = {
      verifySession: () => ({
        tenantId: "22222222-2222-4222-8222-222222222222",
        sessionId: tenantId,
        conversationId: tenantId,
      }),
    } as unknown as CustomerConsentCredentials;
    const mode = { mode: "CONTROLLED_SESSION_V1" as const, tenantId };
    const service = new VerificationCleanupService(prisma, credentials, mode);
    mode.tenantId = "22222222-2222-4222-8222-222222222222";
    await expect(service.end("synthetic")).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it("does not authorize a sweep or reference purge through controlled close mode", async () => {
    const transaction = jest.fn();
    const service = new VerificationCleanupService(
      { $transaction: transaction },
      {} as CustomerConsentCredentials,
      { mode: "CONTROLLED_SESSION_V1", tenantId },
    );
    await expect(service.sweep(tenantId)).rejects.toThrow();
    await expect(service.purgeResolvedReferences(tenantId)).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("exact expired-session maintenance", () => {
  const id = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const binding = () => ({
    mode: "EXACT_SESSION_MAINTENANCE_V1" as const,
    tenantId,
    accountId: id(1),
    approvalId: id(2),
    operationId: id(3),
    validFrom: 100,
    validUntil: 10000,
    targets: [0, 1, 2].map((i) => ({
      conversationId: id(10 + i),
      sessionId: id(20 + i),
      expiresAt: 500,
      operations: [0, 1].map((j) => ({
        id: id(30 + i * 2 + j),
        attemptId: id(40 + i * 2 + j),
        createdAt: 100,
        executionDeadline: 200,
        heldMicros: 100000,
        aliasCount: 1,
        state: "OBSERVED" as const,
      })),
    })),
  });
  function setup() {
    const mode = binding();
    let data: Record<string, unknown> = {
      customerSessionVersion: 1,
      sessionId: mode.targets[0].sessionId,
      verificationLifecycle: {
        version: 1,
        expiresAt: 500,
        closedAt: null,
        purgedAt: null,
      },
      verificationOperations: { private: true },
    };
    const actual = mode.targets.flatMap((t) =>
      t.operations.map((o) => ({
        ...o,
        createdAt: new Date(o.createdAt),
        executionDeadline: new Date(o.executionDeadline),
        tenantId,
        conversationId: t.conversationId,
        sessionId: t.sessionId,
        heldMicros: BigInt(o.heldMicros),
        _count: { requests: 1 },
      })),
    );
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ ms: 1000n }]),
      conversation: {
        findUnique: jest.fn().mockImplementation(() => ({
          id: mode.targets[0].conversationId,
          channel: "WEBCHAT",
          status: "ONGOING",
          collectedData: structuredClone(data),
        })),
        update: jest
          .fn()
          .mockImplementation(
            ({
              data: d,
            }: {
              data: { collectedData: Record<string, unknown> };
            }) => {
              data = d.collectedData;
            },
          ),
      },
      addressVerificationOperation: {
        findMany: jest.fn().mockResolvedValue(actual),
      },
      communicationContent: {
        count: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn(),
      },
      conversationJobLink: { count: jest.fn().mockResolvedValue(0) },
      auditLog: { create: jest.fn() },
    };
    const transaction = jest
      .fn()
      .mockImplementation((fn: (value: typeof tx) => unknown) => fn(tx));
    const credentials = {
      verifySession: jest.fn(),
    } as unknown as CustomerConsentCredentials;
    const service = new VerificationCleanupService(
      { $transaction: transaction } as unknown as Pick<
        PrismaService,
        "$transaction"
      >,
      credentials,
      mode,
    );
    return {
      mode,
      service,
      tx,
      actual,
      transaction,
      credentials,
      target: {
        conversationId: mode.targets[0].conversationId,
        sessionId: mode.targets[0].sessionId,
      },
      data: () => data,
    };
  }
  it("deep copies the exact binding and maintains only its selected expired session", async () => {
    const s = setup();
    s.mode.targets[0].sessionId = id(99);
    s.mode.targets[0].operations[0].heldMicros = 0;
    expect(await s.service.maintain(s.target)).toEqual({
      state: "CLOSED",
      cleanupPending: false,
      deliveryAuthorized: false,
    });
    expect(s.credentials.verifySession).not.toHaveBeenCalled();
    expect(s.data()).not.toHaveProperty("verificationOperations");
    const audit = (
      s.tx.auditLog.create.mock.calls[0] as [
        {
          data: {
            actorId: string;
            metadata: { maintenanceOperationId: string };
          };
        },
      ]
    )[0].data;
    expect(audit.actorId).toBe("controlled-session-maintenance");
    expect(audit.metadata.maintenanceOperationId).toBe(id(3));
  });
  it("refuses wrong entry points and foreign targets before any database access", async () => {
    const s = setup();
    await expect(s.service.end("unused")).rejects.toThrow();
    await expect(s.service.sweep(tenantId)).rejects.toThrow();
    await expect(s.service.purgeResolvedReferences(tenantId)).rejects.toThrow();
    await expect(
      s.service.maintain({ ...s.target, sessionId: id(99) }),
    ).rejects.toThrow();
    expect(s.transaction).not.toHaveBeenCalled();
    expect(s.credentials.verifySession).not.toHaveBeenCalled();
    const fixture = new VerificationCleanupService(
      { $transaction: s.transaction },
      s.credentials,
      "FIXTURE_ONLY",
    );
    await expect(fixture.maintain(s.target)).rejects.toThrow();
    await expect(fixture.inspectMaintenance()).rejects.toThrow();
  });
  it("rejects malformed, duplicate, extra and changed binding authority", () => {
    const variants = [
      (b: ReturnType<typeof binding>) => {
        b.targets.pop();
      },
      (b: ReturnType<typeof binding>) => {
        b.targets.push(b.targets[0]);
      },
      (b: ReturnType<typeof binding>) => {
        b.targets[1].sessionId = b.targets[0].sessionId;
      },
      (b: ReturnType<typeof binding>) => {
        b.targets[1].operations[0].id = b.targets[0].operations[0].id;
      },
      (b: ReturnType<typeof binding>) => {
        b.accountId = "foreign";
      },
      (b: ReturnType<typeof binding>) => {
        b.targets[0].operations[0].heldMicros = 0;
      },
      (b: ReturnType<typeof binding>) => {
        b.validUntil = b.validFrom;
      },
    ];
    for (const change of variants) {
      const b = binding();
      change(b);
      expect(
        () =>
          new VerificationCleanupService(
            { $transaction: jest.fn() },
            {} as CustomerConsentCredentials,
            b,
          ),
      ).toThrow();
    }
  });
  it.each([
    "tenant",
    "account-membership",
    "alias",
    "amount",
    "attempt",
    "expiry",
    "clock",
    "lifecycle-version",
  ])("refuses %s drift before closure", async (kind) => {
    const s = setup();
    if (kind === "tenant") s.actual[0].tenantId = id(99);
    if (kind === "account-membership") s.actual.pop();
    if (kind === "alias") s.actual[0]._count.requests = 2;
    if (kind === "amount") s.actual[0].heldMicros = 0n;
    if (kind === "attempt") s.actual[0].attemptId = id(99);
    if (kind === "clock") s.tx.$queryRaw.mockResolvedValue([{ ms: 10001n }]);
    if (kind === "expiry") s.tx.$queryRaw.mockResolvedValue([{ ms: 400n }]);
    if (kind === "lifecycle-version")
      s.tx.conversation.findUnique.mockResolvedValue({
        id: s.target.conversationId,
        channel: "WEBCHAT",
        collectedData: {
          customerSessionVersion: 2,
          sessionId: s.target.sessionId,
        },
      });
    await expect(s.service.maintain(s.target)).rejects.toThrow();
    expect(s.tx.conversation.update).not.toHaveBeenCalled();
    expect(s.tx.communicationContent.deleteMany).not.toHaveBeenCalled();
  });
  it("retains business payload when a submitted review or linked job exists", async () => {
    for (const relation of [
      "communicationContent",
      "conversationJobLink",
    ] as const) {
      const s = setup();
      s.tx[relation].count.mockResolvedValue(1);
      await s.service.maintain(s.target);
      expect(s.tx.communicationContent.deleteMany).not.toHaveBeenCalled();
    }
  });
  it("reports pending purge after committed closure without retry", async () => {
    const s = setup();
    s.tx.communicationContent.deleteMany.mockRejectedValue(
      Error("private driver text"),
    );
    expect(await s.service.maintain(s.target)).toEqual({
      state: "CLOSED",
      cleanupPending: true,
      deliveryAuthorized: false,
    });
    expect(s.tx.communicationContent.deleteMany).toHaveBeenCalledTimes(1);
  });
});
