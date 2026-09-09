import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { extractIntakeEmail } from "../conversations/conversation-email.service";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { lockCustomerConsentSession } from "./customer-consent-session-lock";

/** Inactive, explicit capture only. Not an AI/triage entry point or consent grant. */
export class CustomerConsentCaptureService {
  constructor(
    private readonly prisma: Pick<PrismaService, "$transaction">,
    private readonly cipher: Pick<
      ConversationMemoryCipher,
      "encrypt" | "decrypt"
    >,
    private readonly credentials: CustomerConsentCredentials,
  ) {}

  async capture(input: { sessionToken: string; email: string }) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "email,sessionToken" ||
      typeof input.sessionToken !== "string" ||
      input.sessionToken.length > 4096 ||
      typeof input.email !== "string" ||
      input.email.length > 254 ||
      !input.email ||
      extractIntakeEmail(input.email) !== input.email
    )
      throw new BadRequestException(
        "A normalized email address and customer credential are required.",
      );
    const session = this.credentials.verifySession(input.sessionToken);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const { capture: prior, hasCapture } =
            await lockCustomerConsentSession(tx, session);
          this.credentials.verifySession(input.sessionToken);
          if (hasCapture !== false) {
            const value = prior as Record<string, unknown>;
            if (
              !value ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              Object.keys(value).sort().join(",") !==
                "askedAt,encryptedEmail,status,version" ||
              value.version !== 1 ||
              value.status !== "captured" ||
              value.askedAt !== null ||
              typeof value.encryptedEmail !== "string" ||
              this.cipher.decrypt(value.encryptedEmail) !== input.email
            )
              throw new ConflictException(
                "Captured email cannot be replaced in this flow.",
              );
          } else {
            const capture = {
              version: 1,
              status: "captured",
              askedAt: null,
              encryptedEmail: this.cipher.encrypt(input.email),
            };
            const updated =
              await tx.$executeRaw(Prisma.sql`UPDATE "Conversation" SET "collectedData"=jsonb_set("collectedData",'{intakeEmail}',${JSON.stringify(capture)}::jsonb), "updatedAt"=clock_timestamp()
            WHERE id=${session.conversationId}::uuid AND "tenantId"=${session.tenantId}::uuid`);
            if (updated !== 1)
              throw new ConflictException("Customer session is unavailable.");
            await tx.auditLog.create({
              data: {
                tenantId: session.tenantId,
                entityType: "Conversation",
                entityId: session.conversationId,
                actorType: "CUSTOMER",
                actorId: "intake-session",
                action: "conversation.email_captured",
                metadata: { version: 1, status: "captured" },
              },
            });
          }
          this.credentials.verifySession(input.sessionToken);
          return {
            status: "captured" as const,
            deliveryAuthorized: false as const,
          };
        },
        { maxWait: 2000, timeout: 5000 },
      );
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500)
        throw error;
      throw new ServiceUnavailableException(
        "Email capture outcome is unconfirmed. Retry only with the same unexpired session.",
      );
    }
  }
}
