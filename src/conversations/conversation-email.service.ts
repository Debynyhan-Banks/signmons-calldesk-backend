import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { isEmail } from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { lockConversationSession } from "./conversation-session-lock";

export const EMAIL_QUESTION =
  "If you’d like us to keep an email address with this request, what is it? You can say skip. This does not send an email.";
type State = {
  version: 1;
  status: "asked" | "declined" | "captured";
  askedAt: string | null;
  encryptedEmail?: string;
};
type Scope = { tenantId: string; conversationId: string; sessionId: string };
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
export function extractIntakeEmail(message: string): string | null {
  if (
    [...message].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    (message.match(/@/g)?.length ?? 0) !== 1
  )
    return null;
  const candidate = message
    .match(/[^\s<>(),;:"']+@[^\s<>(),;:"']+/)?.[0]
    .replace(/[.!?]+$/, "");
  if (
    !candidate ||
    candidate.length > 254 ||
    !isEmail(candidate, { allow_utf8_local_part: false })
  )
    return null;
  const text = message.trim();
  const prefix = message.slice(0, message.indexOf(candidate));
  const introduction = prefix.replace(/^[\s\S]*[.!?;]/, "");
  if (/\b(?:not|never|don't|wrong|old|previous|avoid)\b/i.test(introduction))
    return null;
  const standalone =
    text.replace(/^[<]/, "").replace(/[>.!?]+$/, "") === candidate;
  if (
    !standalone &&
    !/(?:my e-?mail(?: address)? (?:is|:)|e-?mail:|reach me at)\s*$/i.test(
      prefix,
    )
  )
    return null;
  const at = candidate.lastIndexOf("@");
  return candidate.slice(0, at) + "@" + candidate.slice(at + 1).toLowerCase();
}

@Injectable()
export class ConversationEmailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: ConversationMemoryCipher,
  ) {}
  observe(scope: Scope, message: string) {
    return this.change(scope, message, false);
  }
  async requestOnce(scope: Scope): Promise<boolean> {
    return (await this.change(scope, "", true)).ask;
  }
  private async change(scope: Scope, message: string, request: boolean) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockConversationSession(tx, scope.tenantId, scope.sessionId);
        const conversation = await tx.conversation.findFirst({
          where: {
            id: scope.conversationId,
            tenantId: scope.tenantId,
            deletedAt: null,
            collectedData: { path: ["sessionId"], equals: scope.sessionId },
          },
          select: { collectedData: true },
        });
        if (!conversation)
          throw new NotFoundException("Conversation is unavailable.");
        const root = object(conversation.collectedData);
        if (!root)
          throw new ConflictException("Conversation email state needs review.");
        let state: State | undefined;
        if (Object.prototype.hasOwnProperty.call(root, "intakeEmail")) {
          const value = object(root.intakeEmail);
          const validDate =
            value?.askedAt === null ||
            (typeof value?.askedAt === "string" &&
              Number.isFinite(Date.parse(value.askedAt)) &&
              new Date(value.askedAt).toISOString() === value.askedAt);
          if (
            !value ||
            value.version !== 1 ||
            !["asked", "declined", "captured"].includes(String(value.status)) ||
            !validDate ||
            Object.keys(value).some(
              (k) =>
                !["version", "status", "askedAt", "encryptedEmail"].includes(k),
            ) ||
            (value.status === "captured"
              ? typeof value.encryptedEmail !== "string" ||
                !extractIntakeEmail(
                  this.cipher.decrypt(value.encryptedEmail) ?? "",
                )
              : Object.prototype.hasOwnProperty.call(
                  value,
                  "encryptedEmail",
                )) ||
            (value.status === "asked" && value.askedAt === null)
          )
            throw new ConflictException(
              "Conversation email state needs review.",
            );
          state = value as State;
        }
        if (state?.status === "captured")
          return { status: state.status, ask: false };
        const email = extractIntakeEmail(message);
        let next: State | undefined;
        if (email)
          next = {
            version: 1,
            status: "captured",
            askedAt: state?.askedAt ?? null,
            encryptedEmail: this.cipher.encrypt(email),
          };
        else if (
          /^(?:no email|i (?:do not|don't) have (?:an )?email|skip email)[.!]?$/i.test(
            message.trim(),
          ) ||
          (state?.status === "asked" &&
            /^(?:skip|no|no thanks|prefer not to)[.!]?$/i.test(message.trim()))
        )
          next = {
            version: 1,
            status: "declined",
            askedAt: state?.askedAt ?? null,
          };
        else if (request && !state)
          next = {
            version: 1,
            status: "asked",
            askedAt: new Date().toISOString(),
          };
        if (!next || JSON.stringify(next) === JSON.stringify(state))
          return { status: state?.status ?? "missing", ask: false };
        await tx.conversation.update({
          where: {
            id_tenantId: { id: scope.conversationId, tenantId: scope.tenantId },
          },
          data: {
            collectedData: {
              ...root,
              intakeEmail: next,
            } as Prisma.InputJsonValue,
          },
        });
        await tx.auditLog.create({
          data: {
            tenantId: scope.tenantId,
            entityType: "Conversation",
            entityId: scope.conversationId,
            actorType: "CUSTOMER",
            actorId: "intake-session",
            action: `conversation.email_${next.status}`,
            metadata: { version: 1, status: next.status },
          },
        });
        return { status: next.status, ask: next.status === "asked" };
      });
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof NotFoundException
      )
        throw error;
      throw new ServiceUnavailableException(
        "Email capture outcome is unconfirmed. Please retry your message.",
      );
    }
  }
}
