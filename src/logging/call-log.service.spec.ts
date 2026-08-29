import { CallLogService } from "./call-log.service";
import { ConversationMemoryCipher } from "./conversation-memory-cipher.service";
import { SanitizationService } from "../sanitization/sanitization.service";
import type { PrismaService } from "../prisma/prisma.service";
import type appConfig from "../config/app.config";

describe("CallLogService conversational memory", () => {
  it("keeps audit text redacted while restoring encrypted phone data for AI memory", async () => {
    const prisma = {
      communicationEvent: { create: jest.fn().mockResolvedValue({}) },
      communicationContent: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn(),
      },
    };
    const cipher = new ConversationMemoryCipher({
      conversationDataEncryptionKey: "a".repeat(64),
    } as ReturnType<typeof appConfig>);
    const service = new CallLogService(
      prisma as unknown as PrismaService,
      new SanitizationService(),
      cipher,
    );

    await service.createLog({
      tenantId: "tenant-1",
      sessionId: "session-1",
      conversationId: "conversation-1",
      transcript: "My callback number is 216-703-3183.",
    });

    const createInput = prisma.communicationEvent.create.mock.calls[0][0] as {
      data: { content: { create: { payload: Record<string, unknown> } } };
    };
    const storedPayload = createInput.data.content.create.payload;
    expect(storedPayload.message).toBe("My callback number is ***-***-3183.");
    expect(storedPayload.encryptedMessage).not.toContain("2167033183");

    prisma.communicationContent.findMany.mockResolvedValue([
      { payload: storedPayload, createdAt: new Date("2026-08-29T13:00:00Z") },
    ]);
    const history = await service.getRecentMessages("tenant-1", "session-1");
    expect(history[0].content).toBe("My callback number is 216-703-3183.");
  });
});
