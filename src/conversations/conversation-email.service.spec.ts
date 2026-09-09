import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ConversationEmailService,
  extractIntakeEmail,
} from "./conversation-email.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { PrismaService } from "../prisma/prisma.service";
import appConfig from "../config/app.config";

describe("optional intake email", () => {
  const cipher = new ConversationMemoryCipher({
    conversationDataEncryptionKey: "1".repeat(64),
  } as ReturnType<typeof appConfig>);
  const scope = {
    tenantId: "tenant",
    sessionId: "session",
    conversationId: "conversation",
  };
  let root: Record<string, unknown>, service: ConversationEmailService;
  const tx = {
    $queryRaw: jest.fn(),
    conversation: { findFirst: jest.fn(), update: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  beforeEach(() => {
    jest.clearAllMocks();
    root = { sessionId: "session", other: "preserved" };
    tx.conversation.findFirst.mockImplementation(() =>
      Promise.resolve({ collectedData: root }),
    );
    tx.conversation.update.mockImplementation(
      (input: { data: { collectedData: Record<string, unknown> } }) => {
        root = input.data.collectedData;
        return Promise.resolve();
      },
    );
    tx.auditLog.create.mockResolvedValue({});
    service = new ConversationEmailService(
      {
        $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      } as unknown as PrismaService,
      cipher,
    );
  });
  it.each(["Person+tag@EXAMPLE.COM", "My email is Person+tag@EXAMPLE.COM."])(
    "normalizes only the domain: %s",
    (text) => expect(extractIntakeEmail(text)).toBe("Person+tag@example.com"),
  );
  it.each([
    "no address",
    "a@example.com and b@example.com",
    "a@b",
    "a\n@example.com",
    "not a@example.com",
    "don't use this email: a@example.com",
    "old email a@example.com",
    "name@exa..mple.com",
    `${"a".repeat(260)}@example.com`,
  ])("rejects ambiguous, malformed or unconfirmed input: %s", (text) =>
    expect(extractIntakeEmail(text)).toBeNull(),
  );
  it("persists asked once and preserves unrelated JSON", async () => {
    expect(await service.requestOnce(scope)).toBe(true);
    expect(await service.requestOnce(scope)).toBe(false);
    expect(root.other).toBe("preserved");
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
  it("captures encrypted email without leaking it in results or audit, and never overwrites it", async () => {
    expect(
      await service.observe(scope, "my email is First@example.com"),
    ).toEqual({ status: "captured", ask: false });
    const saved = root.intakeEmail as { encryptedEmail: string };
    expect(cipher.decrypt(saved.encryptedEmail)).toBe("First@example.com");
    expect(JSON.stringify(root)).not.toContain("First@example.com");
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(
      "First@example.com",
    );
    expect(await service.requestOnce(scope)).toBe(false);
    await service.observe(scope, "Second@example.com");
    expect(root.intakeEmail).toBe(saved);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
  it("retains decline without asking again and permits a later volunteered address", async () => {
    await service.requestOnce(scope);
    await service.observe(scope, "skip");
    expect(await service.requestOnce(scope)).toBe(false);
    expect((await service.observe(scope, "later@example.com")).status).toBe(
      "captured",
    );
  });
  it("invalid optional input is not persisted or used to ask again", async () => {
    await service.requestOnce(scope);
    await service.observe(scope, "invalid@example");
    expect(await service.requestOnce(scope)).toBe(false);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
  it.each([
    null,
    {},
    { version: 2, status: "asked", askedAt: null },
    {
      version: 1,
      status: "captured",
      askedAt: null,
      encryptedEmail: "corrupt",
    },
    { version: 1, status: "asked", askedAt: null },
  ])("fails closed for malformed prior state %j", async (value) => {
    root.intakeEmail = value;
    await expect(
      service.observe(scope, "new@example.com"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.conversation.update).not.toHaveBeenCalled();
  });
  it("requires matching tenant, conversation, session and non-deletion", async () => {
    tx.conversation.findFirst.mockResolvedValue(null);
    await expect(
      service.observe(scope, "new@example.com"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.conversation.findFirst).toHaveBeenCalledWith({
      where: {
        id: "conversation",
        tenantId: "tenant",
        deletedAt: null,
        collectedData: { path: ["sessionId"], equals: "session" },
      },
      select: { collectedData: true },
    });
  });
  it("hides raw persistence diagnostics on unknown commit outcome", async () => {
    tx.auditLog.create.mockRejectedValue(
      new Error("private-email@example.com"),
    );
    await expect(
      service.observe(scope, "new@example.com"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
