import { randomUUID } from "crypto";
import { ConflictException, Injectable } from "@nestjs/common";
import {
  ConversationChannel,
  ConversationJobRelation,
  ConversationStatus,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SanitizationService } from "../sanitization/sanitization.service";
import { lockConversationSession } from "./conversation-session-lock";

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sanitizationService: SanitizationService,
  ) {}

  async ensureConversation(tenantId: string, sessionId: string) {
    return this.prisma.$transaction(async (tx) => {
      await lockConversationSession(tx, tenantId, sessionId);
      const matches = await tx.conversation.findMany({
        where: {
          tenantId,
          collectedData: {
            path: ["sessionId"],
            equals: sessionId,
          },
        },
        take: 2,
      });

      if (matches.length > 1)
        throw new ConflictException("Conversation needs administrator review.");
      const existing = matches[0];
      if (existing) {
        if (existing.deletedAt)
          throw new ConflictException("Conversation is unavailable.");
        return existing;
      }

      const safeSessionId =
        this.sanitizationService.sanitizeIdentifier(sessionId);
      const safeTenantId =
        this.sanitizationService.sanitizeIdentifier(tenantId);

      const placeholderPhone = `unknown-${safeSessionId ?? randomUUID()}`;
      const customer = await tx.customer.create({
        data: {
          id: randomUUID(),
          tenantId: safeTenantId ?? tenantId,
          phone: placeholderPhone,
          fullName: "Unknown Caller",
          aiMetadata: {
            source: "WEBCHAT",
            status: "PROSPECT",
            sessionId,
          } as Prisma.InputJsonValue,
        },
      });

      return tx.conversation.create({
        data: {
          id: randomUUID(),
          tenantId,
          customerId: customer.id,
          customerTenantId: tenantId,
          channel: ConversationChannel.WEBCHAT,
          status: ConversationStatus.ONGOING,
          currentFSMState: "TRIAGE",
          collectedData: {
            sessionId,
            source: "WEBCHAT",
          } as Prisma.InputJsonValue,
        },
      });
    });
  }

  async linkJobToConversation(params: {
    tenantId: string;
    conversationId: string;
    jobId: string;
    relationType?: ConversationJobRelation;
  }) {
    try {
      return await this.prisma.conversationJobLink.create({
        data: {
          id: randomUUID(),
          tenantId: params.tenantId,
          conversationId: params.conversationId,
          conversationTenantId: params.tenantId,
          jobId: params.jobId,
          jobTenantId: params.tenantId,
          relationType:
            params.relationType ?? ConversationJobRelation.CREATED_FROM,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return null;
      }
      throw error;
    }
  }
}
