import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import {
  CustomerConsentCredentials,
  ConsentSessionClaims,
} from "./customer-consent-credentials";
import { lockCustomerConsentSession } from "./customer-consent-session-lock";
import { validateCustomerIntakeDraft } from "./customer-intake-draft";

export const PROTECTED_INTAKE_TURN = "protected_intake_turn_v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const changed = () =>
  new ConflictException("Customer intake changed or is unavailable.");
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 2000 &&
    ![...value].some((char) => {
      const code = char.charCodeAt(0);
      return (code < 32 && code !== 9 && code !== 10) || code === 127;
    })
  );
}
type Turn = { id: string; revision: number; message: string; reply: string };
export interface CustomerIntakeReply {
  /** Local scripted collaborator only in this checkpoint. No production AI/tool adapter. */
  reply(input: {
    turns: ReadonlyArray<{ message: string; reply: string }>;
    message: string;
  }): Promise<string>;
}

/** Unregistered, no browser route and no AI/booking/provider/consent side effects.
 * The collaborator runs outside database locks. A fresh ownership/history check
 * gates one atomic encrypted turn after it returns; no automatic retry.
 */
export class CustomerIntakeContinuationService {
  constructor(
    private readonly prisma: Pick<PrismaService, "$transaction">,
    private readonly cipher: Pick<
      ConversationMemoryCipher,
      "encrypt" | "decrypt"
    >,
    private readonly credentials: CustomerConsentCredentials,
    private readonly collaborator?: CustomerIntakeReply,
  ) {}

  /** Read-only preview. No job, consent mutation, finalization or delivery admission. */
  async previewDraft(input: {
    sessionToken: string;
    expectedRevision: number;
    draft: unknown;
  }) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !==
        "draft,expectedRevision,sessionToken" ||
      typeof input.sessionToken !== "string" ||
      input.sessionToken.length > 4096 ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      input.expectedRevision > 20
    )
      throw new BadRequestException("Invalid intake draft request.");
    const draft = validateCustomerIntakeDraft(input.draft);
    const session = this.credentials.verifySession(input.sessionToken);
    try {
      return await this.transaction(async (tx) => {
        const history = await this.history(tx, session);
        if (history.turns.length !== input.expectedRevision) throw changed();
        const scope = await tx.appointmentEmailConsentScope.findUnique({
          where: {
            tenantId_conversationId: {
              tenantId: session.tenantId,
              conversationId: session.conversationId,
            },
          },
        });
        if (scope && scope.sessionId !== session.sessionId) throw changed();
        const evidence = scope
          ? await tx.appointmentEmailConsentEvidence.findFirst({
              where: { scopeId: scope.id },
              orderBy: { revision: "desc" },
            })
          : null;
        const emailChoice = evidence?.decision ?? "NOT_RECORDED";
        if (
          !["NOT_RECORDED", "GRANTED", "DECLINED", "REVOKED"].includes(
            emailChoice,
          )
        )
          throw changed();
        this.credentials.verifySession(input.sessionToken);
        return {
          draft,
          transcriptRevision: history.turns.length,
          emailChoice,
          urgencyAssessment: "NOT_PERFORMED" as const,
          requiresHumanReview: true as const,
          jobCreated: false as const,
          bookingAuthorized: false as const,
          deliveryAuthorized: false as const,
        };
      });
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500)
        throw error;
      throw new ServiceUnavailableException("Intake draft unavailable.");
    }
  }

  async continue(input: {
    sessionToken: string;
    interactionId: string;
    message: string;
  }) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !==
        "interactionId,message,sessionToken" ||
      typeof input.sessionToken !== "string" ||
      input.sessionToken.length > 4096 ||
      typeof input.interactionId !== "string" ||
      !UUID.test(input.interactionId) ||
      !text(input.message)
    )
      throw new BadRequestException("Invalid customer intake request.");
    const session = this.credentials.verifySession(input.sessionToken);
    try {
      const first = await this.transaction(async (tx) => {
        const history = await this.history(tx, session);
        this.credentials.verifySession(input.sessionToken);
        const prior = await this.replay(tx, input, history.turns);
        if (prior) return { history, prior };
        if (history.turns.length >= 20) throw changed();
        return { history, prior: null };
      });
      if (first.prior) return this.receipt(first.prior);
      if (!this.collaborator)
        throw new ServiceUnavailableException(
          "Intake collaborator unavailable.",
        );
      let reply: string;
      try {
        reply = await this.collaborator.reply({
          turns: first.history.turns.map(({ message, reply }) => ({
            message,
            reply,
          })),
          message: input.message,
        });
      } catch {
        throw new ServiceUnavailableException("Intake reply unavailable.");
      }
      if (!text(reply))
        throw new ServiceUnavailableException("Intake reply unavailable.");
      this.credentials.verifySession(input.sessionToken);
      return await this.transaction(async (tx) => {
        const current = await this.history(tx, session);
        this.credentials.verifySession(input.sessionToken);
        const prior = await this.replay(tx, input, current.turns);
        if (prior) return this.receipt(prior);
        if (
          current.digest !== first.history.digest ||
          current.turns.length >= 20
        )
          throw changed();
        const revision = current.turns.length + 1;
        await tx.communicationEvent.create({
          data: {
            id: input.interactionId,
            tenantId: session.tenantId,
            conversationId: session.conversationId,
            conversationTenantId: session.tenantId,
            channel: "WEBCHAT",
            direction: "INBOUND",
            provider: "OTHER",
            status: "RECEIVED",
            content: {
              create: {
                tenantId: session.tenantId,
                payload: {
                  version: 1,
                  type: PROTECTED_INTAKE_TURN,
                  sessionId: session.sessionId,
                  revision,
                  encryptedInput: this.cipher.encrypt(input.message),
                  encryptedReply: this.cipher.encrypt(reply),
                },
              },
            },
          },
        });
        await tx.auditLog.create({
          data: {
            tenantId: session.tenantId,
            entityType: "Conversation",
            entityId: session.conversationId,
            actorType: "CUSTOMER",
            actorId: "intake-session",
            action: "conversation.protected_intake_turn",
            metadata: { version: 1, revision },
          },
        });
        this.credentials.verifySession(input.sessionToken);
        return this.receipt({
          id: input.interactionId,
          revision,
          message: input.message,
          reply,
        });
      });
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500)
        throw error;
      throw new ServiceUnavailableException(
        "Intake outcome is unconfirmed. Retry only the same interaction with the same unexpired session.",
      );
    }
  }

  private transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(fn, { maxWait: 2000, timeout: 5000 });
  }
  private receipt(turn: Turn) {
    return {
      reply: turn.reply,
      revision: turn.revision,
      deliveryAuthorized: false as const,
    };
  }
  private async replay(
    tx: Prisma.TransactionClient,
    input: { interactionId: string; message: string },
    turns: Turn[],
  ) {
    const prior = turns.find((turn) => turn.id === input.interactionId);
    if (prior) {
      if (prior.message !== input.message) throw changed();
      return prior;
    }
    // The event ID is globally unique. Never adopt another session's/legacy event.
    const collision = await tx.communicationEvent.findUnique({
      where: { id: input.interactionId },
      select: { id: true },
    });
    if (collision) throw changed();
    return null;
  }
  private async history(
    tx: Prisma.TransactionClient,
    session: ConsentSessionClaims,
  ) {
    const row = await lockCustomerConsentSession(tx, session);
    if (row.status !== "ONGOING") throw changed();
    if (
      await tx.conversationJobLink.count({
        where: {
          tenantId: session.tenantId,
          conversationId: session.conversationId,
        },
      })
    )
      throw changed();
    const rows = await tx.communicationEvent.findMany({
      where: {
        tenantId: session.tenantId,
        conversationId: session.conversationId,
        conversationTenantId: session.tenantId,
        content: {
          is: {
            tenantId: session.tenantId,
            payload: { path: ["type"], equals: PROTECTED_INTAKE_TURN },
          },
        },
      },
      take: 21,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        channel: true,
        direction: true,
        provider: true,
        status: true,
        content: { select: { payload: true } },
      },
    });
    if (rows.length > 20) throw changed();
    const turns = rows
      .map((row) => {
        const payload = row.content?.payload;
        if (
          row.channel !== "WEBCHAT" ||
          row.direction !== "INBOUND" ||
          row.provider !== "OTHER" ||
          row.status !== "RECEIVED" ||
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload)
        )
          throw changed();
        const p = payload as Record<string, unknown>;
        if (
          Object.keys(p).sort().join(",") !==
            "encryptedInput,encryptedReply,revision,sessionId,type,version" ||
          p.version !== 1 ||
          p.type !== PROTECTED_INTAKE_TURN ||
          p.sessionId !== session.sessionId ||
          !Number.isSafeInteger(p.revision) ||
          typeof p.encryptedInput !== "string" ||
          typeof p.encryptedReply !== "string"
        )
          throw changed();
        const message = this.cipher.decrypt(p.encryptedInput),
          reply = this.cipher.decrypt(p.encryptedReply);
        if (!text(message) || !text(reply)) throw changed();
        return { id: row.id, revision: p.revision as number, message, reply };
      })
      .sort((a, b) => a.revision - b.revision);
    if (turns.some((turn, index) => turn.revision !== index + 1))
      throw changed();
    return {
      turns,
      digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    };
  }
}
