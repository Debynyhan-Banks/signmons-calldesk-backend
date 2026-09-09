import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CustomerIntakeContinuationService,
  PROTECTED_INTAKE_TURN,
} from "./customer-intake-continuation.service";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { lockCustomerConsentSession } from "./customer-consent-session-lock";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import appConfig from "../config/app.config";
jest.mock("./customer-consent-session-lock", () => ({
  lockCustomerConsentSession: jest.fn(),
}));

describe("inactive credential-bound transcript continuation", () => {
  const credentials = new CustomerConsentCredentials({
    activeKeyId: "fixture",
    keys: { fixture: Buffer.alloc(32, 9) },
  });
  const cipher = new ConversationMemoryCipher({
    conversationDataEncryptionKey: "1".repeat(64),
  } as ReturnType<typeof appConfig>);
  const scope = {
    tenantId: randomUUID(),
    sessionId: randomUUID(),
    conversationId: randomUUID(),
  };
  const input = () => ({
    sessionToken: credentials.issueSession(scope),
    interactionId: randomUUID(),
    message: "Fictional private intake text",
  });
  const tx = {
    communicationEvent: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    conversationJobLink: { count: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const transaction = jest.fn(),
    reply = jest.fn();
  const service = (collaborator = true) =>
    new CustomerIntakeContinuationService(
      { $transaction: transaction },
      cipher,
      credentials,
      collaborator ? { reply } : undefined,
    );
  const saved = (id = randomUUID(), revision = 1) => ({
    id,
    channel: "WEBCHAT",
    direction: "INBOUND",
    provider: "OTHER",
    status: "RECEIVED",
    content: {
      payload: {
        version: 1,
        type: PROTECTED_INTAKE_TURN,
        sessionId: scope.sessionId,
        revision,
        encryptedInput: cipher.encrypt("Fictional private intake text"),
        encryptedReply: cipher.encrypt("Scripted private reply"),
      },
    },
  });
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(lockCustomerConsentSession).mockResolvedValue({
      status: "ONGOING",
      sessionId: scope.sessionId,
      marker: 1,
      capture: null,
      hasCapture: false,
    });
    tx.communicationEvent.findMany.mockResolvedValue([]);
    tx.communicationEvent.findUnique.mockResolvedValue(null);
    tx.conversationJobLink.count.mockResolvedValue(0);
    tx.communicationEvent.create.mockResolvedValue({});
    tx.auditLog.create.mockResolvedValue({});
    reply.mockResolvedValue("Scripted private reply");
    transaction.mockImplementation((fn: (client: typeof tx) => unknown) =>
      fn(tx),
    );
  });
  it.each([
    {},
    { sessionId: "legacy" },
    {
      sessionToken: "integration-secret",
      interactionId: randomUUID(),
      message: "text",
    },
    { sessionToken: "", interactionId: "bad", message: "text" },
  ])(
    "refuses missing/forged/caller-ID input %# before database",
    async (value) => {
      await expect(
        service().continue(value as ReturnType<typeof input>),
      ).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it.each(["", " ", "x".repeat(2001), "bad\u0000text"])(
    "rejects invalid message %# before database",
    async (message) => {
      await expect(
        service().continue({ ...input(), message }),
      ).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it("rejects caller-provided tenant/history/reply overrides", async () => {
    await expect(
      service().continue({ ...input(), tenantId: scope.tenantId } as ReturnType<
        typeof input
      >),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it("runs scripted reply outside transactions, then writes encrypted pair and audit", async () => {
    let inTransaction = false;
    transaction.mockImplementation(
      async (fn: (client: typeof tx) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await fn(tx);
        } finally {
          inTransaction = false;
        }
      },
    );
    reply.mockImplementation(() => {
      expect(inTransaction).toBe(false);
      return Promise.resolve("Scripted private reply");
    });
    expect(await service().continue(input())).toEqual({
      reply: "Scripted private reply",
      revision: 1,
      deliveryAuthorized: false,
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(tx.communicationEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(tx.communicationEvent.create.mock.calls),
    ).not.toContain("Fictional private intake text");
    expect(
      JSON.stringify(tx.communicationEvent.create.mock.calls),
    ).not.toContain("Scripted private reply");
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(
      "private",
    );
    expect((transaction.mock.calls as unknown[][])[0][1]).toEqual({
      maxWait: 2000,
      timeout: 5000,
    });
  });
  it("missing collaborator refuses after ownership check without a write", async () => {
    await expect(service(false).continue(input())).rejects.toThrow(
      "unconfirmed",
    );
    expect(tx.communicationEvent.create).not.toHaveBeenCalled();
  });
  it.each(["", "x".repeat(2001), null])(
    "refuses invalid scripted reply %# without writes",
    async (value) => {
      reply.mockResolvedValue(value);
      await expect(service().continue(input())).rejects.toThrow("unconfirmed");
      expect(tx.communicationEvent.create).not.toHaveBeenCalled();
    },
  );
  it("replays the original committed turn without invoking a collaborator", async () => {
    const request = input();
    tx.communicationEvent.findMany.mockResolvedValue([
      saved(request.interactionId),
    ]);
    expect(await service(false).continue(request)).toEqual({
      reply: "Scripted private reply",
      revision: 1,
      deliveryAuthorized: false,
    });
    expect(reply).not.toHaveBeenCalled();
    expect(tx.communicationEvent.create).not.toHaveBeenCalled();
    await expect(
      service().continue({ ...request, message: "changed" }),
    ).rejects.toThrow("changed");
  });
  it("refuses event ID collision rather than adopting another history", async () => {
    tx.communicationEvent.findUnique.mockResolvedValue({ id: "occupied" });
    await expect(service().continue(input())).rejects.toThrow("changed");
    expect(reply).not.toHaveBeenCalled();
  });
  it.each(["COMPLETED", "ABANDONED"])(
    "refuses non-ongoing status %s before collaborator",
    async (status) => {
      jest.mocked(lockCustomerConsentSession).mockResolvedValue({
        status,
        sessionId: scope.sessionId,
        marker: 1,
        capture: null,
        hasCapture: false,
      });
      await expect(service().continue(input())).rejects.toThrow("changed");
      expect(reply).not.toHaveBeenCalled();
    },
  );
  it("refuses job-linked sessions", async () => {
    tx.conversationJobLink.count.mockResolvedValue(1);
    await expect(service().continue(input())).rejects.toThrow("changed");
    expect(reply).not.toHaveBeenCalled();
  });
  it.each([0, 2, 1.5])(
    "refuses invalid/gapped history revision %s",
    async (revision) => {
      tx.communicationEvent.findMany.mockResolvedValue([
        saved(randomUUID(), revision),
      ]);
      await expect(service().continue(input())).rejects.toThrow("changed");
      expect(reply).not.toHaveBeenCalled();
    },
  );
  it("refuses corrupted encrypted history without plaintext fallback", async () => {
    const row = saved();
    row.content.payload.encryptedInput = "unreadable";
    tx.communicationEvent.findMany.mockResolvedValue([row]);
    await expect(service().continue(input())).rejects.toThrow("changed");
    expect(reply).not.toHaveBeenCalled();
  });
  it("caps stored history at twenty turns", async () => {
    tx.communicationEvent.findMany.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => saved(randomUUID(), i + 1)),
    );
    await expect(service().continue(input())).rejects.toThrow("changed");
    expect(reply).not.toHaveBeenCalled();
  });
  it("refuses a competing history after the scripted reply, without saving stale output", async () => {
    reply.mockImplementation(() => {
      tx.communicationEvent.findMany.mockResolvedValue([saved()]);
      return Promise.resolve("stale response");
    });
    await expect(service().continue(input())).rejects.toThrow("changed");
    expect(tx.communicationEvent.create).not.toHaveBeenCalled();
  });
  it("sanitizes collaborator/storage errors", async () => {
    reply.mockRejectedValueOnce(new Error("PRIVATE_CONTENT"));
    await expect(service().continue(input())).rejects.toThrow("unconfirmed");
    reply.mockRejectedValueOnce(new BadRequestException("PRIVATE_REPLY"));
    await expect(service().continue(input())).rejects.toThrow("unconfirmed");
    tx.auditLog.create.mockRejectedValueOnce(new Error("PRIVATE_DATABASE"));
    await expect(service().continue(input())).rejects.toThrow("unconfirmed");
  });
  it("remains unregistered and absent from browser operation dispatch", () => {
    for (const file of [
      "communications.module.ts",
      "customer-consent-browser-transport.ts",
    ])
      expect(readFileSync(join(__dirname, file), "utf8")).not.toContain(
        "CustomerIntakeContinuation",
      );
  });
});
