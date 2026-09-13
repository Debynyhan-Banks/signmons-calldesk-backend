import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { extractIntakeEmail } from "../conversations/conversation-email.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";

export const EMAIL_CONSENT_PROMPT_VERSION = "APPOINTMENT_EMAIL_OPT_IN_V1";
const PURPOSE = "APPOINTMENT_UPDATES_V1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = () =>
  new ConflictException("Appointment email consent evidence needs review.");
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

export function parseEmailConsentReceipt(value: unknown) {
  const v = object(value);
  if (
    !v ||
    Object.keys(v).sort().join(",") !==
      [
        "version",
        "purpose",
        "promptVersion",
        "sessionId",
        "response",
        "interactionId",
        "expectedRevision",
      ]
        .sort()
        .join(",") ||
    v.version !== 1 ||
    v.purpose !== PURPOSE ||
    v.promptVersion !== EMAIL_CONSENT_PROMPT_VERSION ||
    typeof v.sessionId !== "string" ||
    !v.sessionId.trim() ||
    v.sessionId.length > 64 ||
    typeof v.interactionId !== "string" ||
    !UUID.test(v.interactionId) ||
    !["GRANTED", "DECLINED", "REVOKED"].includes(String(v.response)) ||
    !Number.isSafeInteger(v.expectedRevision) ||
    Number(v.expectedRevision) < 0 ||
    Number(v.expectedRevision) >= 2147483647
  )
    throw fail();
  return {
    sessionId: v.sessionId,
    interactionId: v.interactionId,
    decision: v.response as "GRANTED" | "DECLINED" | "REVOKED",
    expectedRevision: Number(v.expectedRevision),
  };
}

/** No implementation or key configuration is supplied in this checkpoint.
 * Future adapter must use a separately approved tenant-scoped keyed fingerprint.
 * This port is NOT customer authentication, mailbox verification or consent.
 */
export interface EmailConsentFingerprint {
  fingerprint(
    tenantId: string,
    normalizedMailbox: string,
  ): { digest: string; keyVersion: string };
}
type ScopeInput = {
  tenantId: string;
  conversationId: string;
  sourceAuditId: string;
};
function validateIds(input: object, keys: string[]) {
  if (
    !input ||
    Object.keys(input).sort().join(",") !== [...keys].sort().join(",") ||
    !Object.values(input).every((v) => typeof v === "string" && UUID.test(v))
  )
    throw fail();
}

/** Inactive transaction-local persistence only: no DI registration or production caller.
 * A future reviewed customer boundary MUST authenticate the session and record a
 * structured, purpose/prompt-bound customer response audit in this transaction.
 * Audit shape/xmin proves local linkage, NOT the authenticity of a remote customer.
 * Callers must propagate exceptions to roll back the transaction.
 */
export class AppointmentEmailConsentEvidenceStore {
  constructor(
    private readonly cipher: Pick<ConversationMemoryCipher, "decrypt">,
    private readonly fingerprints?: EmailConsentFingerprint,
  ) {}

  async record(tx: Prisma.TransactionClient, input: ScopeInput) {
    validateIds(input, ["tenantId", "conversationId", "sourceAuditId"]);
    if (!this.fingerprints)
      throw new ServiceUnavailableException(
        "Email consent fingerprint authority is unavailable.",
      );
    try {
      const { tenantId, conversationId, sourceAuditId } = input;
      // Consistent lock order: tenant, conversation/customer, scope, then job in bind.
      const tenants = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM "TenantOrganization" WHERE id = ${tenantId}::uuid AND status = 'ACTIVE' FOR SHARE`);
      if (tenants.length !== 1) throw fail();
      const rows = await tx.$queryRaw<
        { customerId: string; collectedData: unknown }[]
      >(Prisma.sql`
    SELECT c."customerId", jsonb_build_object('sessionId', c."collectedData" -> 'sessionId',
      'intakeEmail', c."collectedData" -> 'intakeEmail') AS "collectedData" FROM "Conversation" c
    JOIN "Customer" customer ON customer.id = c."customerId" AND customer."tenantId" = c."customerTenantId"
      AND customer."tenantId" = c."tenantId" AND customer."deletedAt" IS NULL
    WHERE c.id = ${conversationId}::uuid AND c."tenantId" = ${tenantId}::uuid
      AND c."deletedAt" IS NULL AND c.channel = 'WEBCHAT' FOR UPDATE OF c FOR SHARE OF customer`);
      if (rows.length !== 1) throw fail();
      const audits = await tx.$queryRaw<
        { metadata: unknown; currentTransaction: boolean }[]
      >(Prisma.sql`
    SELECT a.metadata, a.xmin = pg_current_xact_id()::xid AS "currentTransaction"
    FROM "AuditLog" a WHERE a.id = ${sourceAuditId}::uuid AND a."tenantId" = ${tenantId}::uuid
      AND a."entityType" = 'Conversation' AND a."entityId" = ${conversationId}
      AND a.action = 'conversation.appointment_email_permission'
      AND a."actorType" = 'CUSTOMER' AND a."actorId" = 'intake-session'
      AND a."actorUserId" IS NULL AND a."actorUserTenantId" IS NULL FOR SHARE`);
      if (audits.length !== 1) throw fail();
      const receipt = parseEmailConsentReceipt(audits[0].metadata);
      const root = object(rows[0].collectedData);
      if (root?.sessionId !== receipt.sessionId) throw fail();
      const existing = await tx.appointmentEmailConsentEvidence.findUnique({
        where: { sourceAuditId_tenantId: { sourceAuditId, tenantId } },
        select: { id: true, scopeId: true, revision: true },
      });
      // A replay returns an evidence receipt only, never current permission.
      if (existing) return { ...existing, deliveryAuthorized: false as const };
      if (!audits[0].currentTransaction) throw fail();
      const capture = object(root.intakeEmail);
      if (
        !capture ||
        capture.version !== 1 ||
        capture.status !== "captured" ||
        Object.keys(capture).some(
          (key) =>
            !["version", "status", "askedAt", "encryptedEmail"].includes(key),
        ) ||
        !(
          capture.askedAt === null ||
          (typeof capture.askedAt === "string" &&
            Number.isFinite(Date.parse(capture.askedAt)) &&
            new Date(capture.askedAt).toISOString() === capture.askedAt)
        ) ||
        typeof capture.encryptedEmail !== "string"
      )
        throw fail();
      const mailbox = this.cipher.decrypt(capture.encryptedEmail);
      if (!mailbox || extractIntakeEmail(mailbox) !== mailbox) throw fail();
      const fingerprint = this.fingerprints.fingerprint(tenantId, mailbox);
      if (
        !/^[0-9a-f]{64}$/.test(fingerprint.digest) ||
        !/^[a-zA-Z0-9_-]{1,32}$/.test(fingerprint.keyVersion)
      )
        throw fail();
      // Address capture is a mailbox source only. It cannot create a receipt.
      await tx.appointmentEmailConsentScope.createMany({
        skipDuplicates: true,
        data: {
          id: randomUUID(),
          tenantId,
          conversationId,
          sessionId: receipt.sessionId,
          intakeCustomerId: rows[0].customerId,
        },
      });
      const scope = await tx.appointmentEmailConsentScope.findUnique({
        where: { tenantId_conversationId: { tenantId, conversationId } },
      });
      if (
        !scope ||
        scope.sessionId !== receipt.sessionId ||
        scope.intakeCustomerId !== rows[0].customerId
      )
        throw fail();
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "AppointmentEmailConsentScope" WHERE id = ${scope.id}::uuid FOR UPDATE`,
      );
      const current = await tx.appointmentEmailConsentEvidence.findFirst({
        where: { scopeId: scope.id },
        orderBy: { revision: "desc" },
      });
      if ((current?.revision ?? 0) !== receipt.expectedRevision) throw fail();
      if (
        receipt.decision === "REVOKED" &&
        (!current ||
          current.decision !== "GRANTED" ||
          current.mailboxFingerprint !== fingerprint.digest ||
          current.fingerprintKeyVersion !== fingerprint.keyVersion)
      )
        throw fail();
      const evidence = await tx.appointmentEmailConsentEvidence.create({
        data: {
          tenantId,
          scopeId: scope.id,
          sourceAuditId,
          revision: receipt.expectedRevision + 1,
          decision: receipt.decision,
          purpose: PURPOSE,
          promptVersion: EMAIL_CONSENT_PROMPT_VERSION,
          interactionId: receipt.interactionId,
          encryptedEmail: capture.encryptedEmail,
          mailboxFingerprint: fingerprint.digest,
          fingerprintKeyVersion: fingerprint.keyVersion,
        },
        select: { id: true, scopeId: true, revision: true },
      });
      return { ...evidence, deliveryAuthorized: false as const };
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException(
        "Email consent evidence outcome is unconfirmed.",
      );
    }
  }

  async bindJob(
    tx: Prisma.TransactionClient,
    input: { tenantId: string; conversationId: string; jobId: string },
  ) {
    validateIds(input, ["tenantId", "conversationId", "jobId"]);
    try {
      const { tenantId, conversationId, jobId } = input;
      const tenants = await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "TenantOrganization" WHERE id = ${tenantId}::uuid AND status = 'ACTIVE' FOR SHARE`,
      );
      if (!Array.isArray(tenants) || tenants.length !== 1) throw fail();
      const conversations = await tx.$queryRaw<
        { customerId: string; sessionId: string }[]
      >(Prisma.sql`
    SELECT c."customerId", c."collectedData" ->> 'sessionId' AS "sessionId" FROM "Conversation" c
    JOIN "Customer" customer ON customer.id = c."customerId" AND customer."tenantId" = c."customerTenantId"
     AND customer."tenantId" = c."tenantId" AND customer."deletedAt" IS NULL
    WHERE c.id = ${conversationId}::uuid AND c."tenantId" = ${tenantId}::uuid AND c."deletedAt" IS NULL
    FOR UPDATE OF c FOR SHARE OF customer`);
      if (conversations.length !== 1) throw fail();
      const scopes = await tx.$queryRaw<
        { id: string; sessionId: string; intakeCustomerId: string }[]
      >(Prisma.sql`
    SELECT id,"sessionId","intakeCustomerId" FROM "AppointmentEmailConsentScope"
    WHERE "tenantId" = ${tenantId}::uuid AND "conversationId" = ${conversationId}::uuid FOR UPDATE`);
      const scope = scopes[0];
      if (
        scopes.length !== 1 ||
        scope.sessionId !== conversations[0].sessionId ||
        scope.intakeCustomerId !== conversations[0].customerId
      )
        throw fail();
      const jobs = await tx.$queryRaw<
        { customerId: string; intakeSessionId: string }[]
      >(Prisma.sql`
    SELECT j."customerId",j."intakeSessionId" FROM "Job" j
    JOIN "Customer" customer ON customer.id = j."customerId" AND customer."tenantId" = j."customerTenantId"
     AND customer."tenantId" = j."tenantId" AND customer."deletedAt" IS NULL
    WHERE j.id = ${jobId}::uuid AND j."tenantId" = ${tenantId}::uuid AND j."deletedAt" IS NULL
    FOR UPDATE OF j FOR SHARE OF customer`);
      if (jobs.length !== 1 || jobs[0].intakeSessionId !== scope.sessionId)
        throw fail();
      // Both FK parents are exclusively locked: competing link inserts must wait.
      const links = await tx.conversationJobLink.findMany({
        where: {
          relationType: "CREATED_FROM",
          OR: [{ jobId }, { conversationId }],
        },
        take: 2,
      });
      const link = links[0];
      if (
        links.length !== 1 ||
        link.tenantId !== tenantId ||
        link.jobTenantId !== tenantId ||
        link.conversationTenantId !== tenantId ||
        link.jobId !== jobId ||
        link.conversationId !== conversationId
      )
        throw fail();
      const current = await tx.appointmentEmailConsentEvidence.findFirst({
        where: { scopeId: scope.id },
        orderBy: { revision: "desc" },
      });
      if (!current) throw fail();
      const existing = await tx.appointmentEmailConsentBinding.findUnique({
        where: { scopeId: scope.id },
      });
      if (existing) {
        if (
          existing.jobId !== jobId ||
          existing.jobCustomerId !== jobs[0].customerId ||
          existing.originLinkId !== link.id
        )
          throw fail();
      } else
        await tx.appointmentEmailConsentBinding.create({
          data: {
            scopeId: scope.id,
            tenantId,
            jobId,
            jobCustomerId: jobs[0].customerId,
            originLinkId: link.id,
          },
        });
      return { scopeId: scope.id, jobId, deliveryAuthorized: false as const };
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException(
        "Email consent binding outcome is unconfirmed.",
      );
    }
  }
}
