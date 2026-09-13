import { ForbiddenException } from "@nestjs/common";
import { ConversationsService } from "./conversations.service";
import { ConversationEmailService } from "./conversation-email.service";
import { PrismaService } from "../prisma/prisma.service";
import { SanitizationService } from "../sanitization/sanitization.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";

describe("legacy intake refuses protected customer sessions", () => {
  it.each([1, 0, null, false, "1", {}, []])(
    "refuses any marker, including malformed %j, before reads/writes",
    async (marker) => {
      const root = { sessionId: "session", customerSessionVersion: marker };
      const tx = {
        $queryRaw: jest.fn(),
        conversation: {
          findMany: jest.fn().mockResolvedValue([{ collectedData: root }]),
          findFirst: jest.fn().mockResolvedValue({ collectedData: root }),
          create: jest.fn(),
          update: jest.fn(),
        },
        customer: { create: jest.fn() },
        auditLog: { create: jest.fn() },
      };
      const prisma = {
        $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
      } as unknown as PrismaService;
      const conversations = new ConversationsService(
        prisma,
        new SanitizationService(),
      );
      const email = new ConversationEmailService(
        prisma,
        {} as ConversationMemoryCipher,
      );
      const scope = {
        tenantId: "tenant",
        conversationId: "conversation",
        sessionId: "session",
      };
      await expect(
        conversations.ensureConversation("tenant", "session"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        email.observe(scope, "replacement@example.invalid"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(email.requestOnce(scope)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(tx.conversation.create).not.toHaveBeenCalled();
      expect(tx.conversation.update).not.toHaveBeenCalled();
      expect(tx.customer.create).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    },
  );
  it("preserves ordinary legacy conversation reuse", async () => {
    const row = { id: "old", collectedData: { sessionId: "legacy" } };
    const tx = {
      $queryRaw: jest.fn(),
      conversation: { findMany: jest.fn().mockResolvedValue([row]) },
    };
    const service = new ConversationsService(
      {
        $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
      } as unknown as PrismaService,
      new SanitizationService(),
    );
    expect(await service.ensureConversation("tenant", "legacy")).toBe(row);
  });
});
