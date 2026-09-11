import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { getRequestContext } from "../common/context/request-context";
import { extractIntakeEmail } from "../conversations/conversation-email.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { PrismaService } from "../prisma/prisma.service";
import { lockConversationSession } from "../conversations/conversation-session-lock";
import { CUSTOMER_SESSION_MARKER } from "../conversations/protected-customer-session";
import { lockCustomerConsentSession } from "./customer-consent-session-lock";
import {
  AppointmentEmailConsentEvidenceStore,
  EMAIL_CONSENT_PROMPT_VERSION,
} from "./appointment-email-consent-evidence";
import {
  CONSENT_PROMPT,
  CustomerConsentCredentials,
  ConsentSessionClaims,
} from "./customer-consent-credentials";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const conflict = () =>
  new ConflictException("Customer consent state changed or is unavailable.");
function body(value: unknown, keys: string[], booleanKeys: string[] = []) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",") ||
    !Object.entries(value).every(([key, v]) =>
      booleanKeys.includes(key)
        ? typeof v === "boolean"
        : typeof v === "string" && v.length > 0 && v.length <= 4096,
    )
  )
    throw new BadRequestException("Invalid customer consent response.");
}
function object(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
/** Local-only model: deliberately unregistered. No controller or live caller.
 * Before activation: review HTTPS/BFF delivery, origin/CSRF/abuse controls,
 * full credential-bound AI intake, key lifecycle and retention integration.
 */
export class CustomerConsentResponseService {
  constructor(
    private readonly prisma: Pick<PrismaService, "$transaction">,
    private readonly cipher: Pick<ConversationMemoryCipher, "decrypt">,
    private readonly credentials: CustomerConsentCredentials,
    private readonly evidence: Pick<
      AppointmentEmailConsentEvidenceStore,
      "record"
    >,
  ) {}

  async start() {
    const ctx = getRequestContext();
    if (
      !ctx?.tenantId ||
      !UUID.test(ctx.tenantId) ||
      ctx.role !== "webchat_integration" ||
      !ctx.userId?.startsWith("integration:") ||
      ctx.impersonatedTenantId
    )
      throw new ForbiddenException(
        "A verified webchat integration is required.",
      );
    this.credentials.assertAvailable();
    const tenantId = ctx.tenantId;
    return this.prisma
      .$transaction(
        async (tx) => {
          // Never adopt a caller's ID; use the shared lock order before creation.
          const sessionId = randomUUID();
          const conversationId = randomUUID();
          const token = this.credentials.issueSession({
            tenantId,
            conversationId,
            sessionId,
          });
          const claims = this.credentials.verifySession(token);
          await lockConversationSession(tx, tenantId, sessionId);
          const rows = await tx.$queryRaw(
            Prisma.sql`SELECT id FROM "TenantOrganization" WHERE id=${tenantId}::uuid AND status='ACTIVE' FOR SHARE`,
          );
          if (!Array.isArray(rows) || rows.length !== 1) throw conflict();
          const customer = await tx.customer.create({
            data: {
              tenantId,
              phone: "unknown-" + sessionId,
              fullName: "Unknown Caller",
            },
          });
          const conversation = await tx.conversation.create({
            data: {
              id: conversationId,
              tenantId,
              customerId: customer.id,
              customerTenantId: tenantId,
              channel: "WEBCHAT",
              status: "ONGOING",
              currentFSMState: "TRIAGE",
              collectedData: {
                sessionId,
                source: "WEBCHAT",
                [CUSTOMER_SESSION_MARKER]: 1,
                verificationLifecycle: {
                  version: 1,
                  expiresAt: claims.expiresAt,
                  closedAt: null,
                  purgedAt: null,
                },
              },
            },
          });
          if (conversation.id !== conversationId) throw conflict();
          return {
            sessionToken: token,
            expiresAt: new Date(claims.expiresAt).toISOString(),
            deliveryAuthorized: false as const,
          };
        },
        { maxWait: 2000, timeout: 5000 },
      )
      .catch((error) => {
        throw this.publicError(error);
      });
  }

  async prompt(input: { sessionToken: string }) {
    body(input, ["sessionToken"]);
    const session = this.credentials.verifySession(input.sessionToken);
    return this.prisma
      .$transaction(
        async (tx) => {
          const mailbox = await this.lockMailbox(tx, session);
          const scope = await tx.appointmentEmailConsentScope.findUnique({
            where: {
              tenantId_conversationId: {
                tenantId: session.tenantId,
                conversationId: session.conversationId,
              },
            },
          });
          const current = scope
            ? await tx.appointmentEmailConsentEvidence.findFirst({
                where: { scopeId: scope.id },
                orderBy: { revision: "desc" },
              })
            : null;
          this.credentials.verifySession(input.sessionToken);
          if (current)
            return {
              state: "completed" as const,
              deliveryAuthorized: false as const,
            };
          const promptToken = this.credentials.issuePrompt(
            input.sessionToken,
            mailbox.digest,
            0,
          );
          return {
            state: "prompt" as const,
            prompt: CONSENT_PROMPT,
            mailbox: mailbox.email,
            promptToken,
            expiresAt: new Date(
              this.credentials.verifyPrompt(
                promptToken,
                input.sessionToken,
              ).expiresAt,
            ).toISOString(),
            sensitivity: "customer-private" as const,
            deliveryAuthorized: false as const,
          };
        },
        { maxWait: 2000, timeout: 5000 },
      )
      .catch((error) => {
        throw this.publicError(error);
      });
  }

  async respond(input: {
    sessionToken: string;
    promptToken: string;
    response: string;
    mailboxConfirmed: boolean;
  }) {
    body(
      input,
      ["sessionToken", "promptToken", "response", "mailboxConfirmed"],
      ["mailboxConfirmed"],
    );
    if (
      !["GRANTED", "DECLINED"].includes(input.response) ||
      (input.response === "GRANTED" && input.mailboxConfirmed !== true)
    )
      throw new BadRequestException("Choose an explicit consent response.");
    // No owner, integration key, appointment token, boolean or caller session ID is substituted.
    const session = this.credentials.verifySession(input.sessionToken);
    this.credentials.verifyPrompt(input.promptToken, input.sessionToken);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const mailbox = await this.lockMailbox(tx, session);
          const prompt = this.credentials.verifyPrompt(
            input.promptToken,
            input.sessionToken,
          );
          if (prompt.mailboxDigest !== mailbox.digest) throw conflict();
          const prior = await tx.appointmentEmailConsentEvidence.findUnique({
            where: {
              tenantId_interactionId: {
                tenantId: session.tenantId,
                interactionId: prompt.jti,
              },
            },
            include: { scope: true },
          });
          if (prior) {
            if (
              prior.decision !== input.response ||
              prior.scope.conversationId !== session.conversationId ||
              prior.scope.sessionId !== session.sessionId ||
              prior.revision !== prompt.expectedRevision + 1
            )
              throw conflict();
            return {
              id: prior.id,
              scopeId: prior.scopeId,
              revision: prior.revision,
              deliveryAuthorized: false as const,
            };
          }
          const scope = await tx.appointmentEmailConsentScope.findUnique({
            where: {
              tenantId_conversationId: {
                tenantId: session.tenantId,
                conversationId: session.conversationId,
              },
            },
          });
          if (
            scope &&
            (await tx.appointmentEmailConsentEvidence.findFirst({
              where: { scopeId: scope.id },
            }))
          )
            throw conflict();
          if (prompt.expectedRevision !== 0) throw conflict();
          const audit = await tx.auditLog.create({
            data: {
              tenantId: session.tenantId,
              entityType: "Conversation",
              entityId: session.conversationId,
              action: "conversation.appointment_email_permission",
              actorType: "CUSTOMER",
              actorId: "intake-session",
              metadata: {
                version: 1,
                purpose: "APPOINTMENT_UPDATES_V1",
                promptVersion: EMAIL_CONSENT_PROMPT_VERSION,
                sessionId: session.sessionId,
                response: input.response,
                interactionId: prompt.jti,
                expectedRevision: prompt.expectedRevision,
              },
            },
          });
          const result = await this.evidence.record(tx, {
            tenantId: session.tenantId,
            conversationId: session.conversationId,
            sourceAuditId: audit.id,
          });
          // A token can expire while locks/storage are awaited. Throw rolls back all writes.
          this.credentials.verifyPrompt(input.promptToken, input.sessionToken);
          return result;
        },
        { maxWait: 2000, timeout: 5000 },
      );
    } catch (error) {
      throw this.publicError(error);
    }
  }

  private publicError(error: unknown) {
    if (
      error instanceof ConflictException ||
      error instanceof BadRequestException ||
      error instanceof ForbiddenException ||
      error instanceof UnauthorizedException
    )
      return error;
    return new ServiceUnavailableException(
      "Customer consent outcome is unconfirmed. Retry with the same unexpired session; if it is lost, start a new request.",
    );
  }

  private async lockMailbox(
    tx: Prisma.TransactionClient,
    session: ConsentSessionClaims,
  ) {
    const state = await lockCustomerConsentSession(tx, session);
    if (state.status !== "ONGOING") throw conflict();
    const capture = object(state.capture);
    if (
      !capture ||
      capture.version !== 1 ||
      capture.status !== "captured" ||
      typeof capture.encryptedEmail !== "string" ||
      Object.keys(capture).some(
        (k) => !["version", "status", "askedAt", "encryptedEmail"].includes(k),
      ) ||
      !(
        capture.askedAt === null ||
        (typeof capture.askedAt === "string" &&
          Number.isFinite(Date.parse(capture.askedAt)) &&
          new Date(capture.askedAt).toISOString() === capture.askedAt)
      )
    )
      throw conflict();
    const email = this.cipher.decrypt(capture.encryptedEmail);
    if (!email || extractIntakeEmail(email) !== email) throw conflict();
    // Hash randomized ciphertext, not a guessable address. Any replacement/re-encryption
    // invalidates the prompt conservatively. This is not the consent fingerprint key.
    return {
      email,
      digest: createHash("sha256").update(capture.encryptedEmail).digest("hex"),
    };
  }
}
