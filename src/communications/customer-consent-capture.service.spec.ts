import { randomUUID } from "node:crypto";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { CustomerConsentCaptureService } from "./customer-consent-capture.service";

describe("inactive credential-bound email capture", () => {
  const credentials = new CustomerConsentCredentials({
    activeKeyId: "test",
    keys: { test: Buffer.alloc(32, 7) },
  });
  const scope = {
    tenantId: randomUUID(),
    conversationId: randomUUID(),
    sessionId: randomUUID(),
  };
  let marker: unknown, prior: unknown, sessionStatus: string;
  const tx = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    auditLog: { create: jest.fn() },
  };
  const transaction = jest.fn();
  const cipher = {
    encrypt: jest.fn().mockReturnValue("encrypted"),
    decrypt: jest.fn().mockReturnValue("a@example.invalid"),
  };
  const service = new CustomerConsentCaptureService(
    { $transaction: transaction },
    cipher,
    credentials,
  );
  const input = () => ({
    sessionToken: credentials.issueSession(scope),
    email: "a@example.invalid",
  });
  beforeEach(() => {
    jest.clearAllMocks();
    tx.$queryRaw.mockReset();
    marker = 1;
    prior = null;
    sessionStatus = "ONGOING";
    tx.$queryRaw
      .mockResolvedValueOnce([{ locked: 1 }])
      .mockResolvedValueOnce([{ id: scope.tenantId }])
      .mockImplementation(() =>
        Promise.resolve([
          {
            sessionId: scope.sessionId,
            status: sessionStatus,
            marker,
            capture: prior,
            hasCapture: prior !== null,
          },
        ]),
      );
    tx.auditLog.create.mockResolvedValue({});
    tx.$executeRaw.mockResolvedValue(1);
    transaction.mockImplementation((fn: (client: typeof tx) => unknown) =>
      fn(tx),
    );
  });
  it.each([
    {},
    { sessionToken: "integration", email: "a@example.invalid" },
    { sessionToken: "bad", email: "my email is a@example.invalid" },
    { sessionToken: "bad", email: "a@EXAMPLE.INVALID" },
  ])("rejects invalid input %# before database", async (value) => {
    await expect(
      service.capture(value as ReturnType<typeof input>),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it("rejects caller scope overrides", async () => {
    await expect(
      service.capture({ ...input(), tenantId: scope.tenantId } as ReturnType<
        typeof input
      >),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 0, "1", {}])(
    "does not adopt unprotected or malformed marker %j",
    async (value) => {
      marker = value;
      await expect(service.capture(input())).rejects.toThrow("unavailable");
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    },
  );
  it("atomically writes encrypted capture and privacy-safe audit", async () => {
    expect(await service.capture(input())).toEqual({
      status: "captured",
      deliveryAuthorized: false,
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(
      "a@example",
    );
    expect((transaction.mock.calls as unknown[][])[0][1]).toEqual({
      maxWait: 2000,
      timeout: 5000,
    });
  });
  it.each(["COMPLETED", "ABANDONED"])(
    "refuses capture for closed session %s",
    async (status) => {
      sessionStatus = status;
      await expect(service.capture(input())).rejects.toThrow("unavailable");
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    },
  );
  it("replays identical capture without rewriting ciphertext or audit", async () => {
    prior = {
      version: 1,
      status: "captured",
      askedAt: null,
      encryptedEmail: "encrypted",
    };
    await service.capture(input());
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it.each([false, [], {}, { version: 1, status: "declined", askedAt: null }])(
    "refuses malformed or incompatible stored capture %j",
    async (value) => {
      prior = value;
      await expect(service.capture(input())).rejects.toThrow(
        "cannot be replaced",
      );
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    },
  );
  it("refuses address replacement", async () => {
    prior = {
      version: 1,
      status: "captured",
      askedAt: null,
      encryptedEmail: "encrypted",
    };
    await expect(
      service.capture({ ...input(), email: "different@example.invalid" }),
    ).rejects.toThrow("cannot be replaced");
  });
  it("sanitizes unknown database failures", async () => {
    tx.auditLog.create.mockRejectedValueOnce(new Error("PRIVATE"));
    await expect(service.capture(input())).rejects.toThrow(
      "outcome is unconfirmed",
    );
  });
});
