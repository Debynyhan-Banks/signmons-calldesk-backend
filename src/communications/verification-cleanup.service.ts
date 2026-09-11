import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { lockConversationSession } from "../conversations/conversation-session-lock";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import {
  lifecycle,
  sessionCleanupDue,
  resolvedReferenceDue,
} from "./verification-retention";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Scope = { tenantId: string; conversationId: string; sessionId: string };
/** Inactive fixture-owned lifecycle worker. No scheduler/production registration.
 * Only explicitly marked protected sessions qualify. No bearer is needed by a sweep.
 * Close commits before retryable purge, so failed deletion never restores eligibility.
 */
export class VerificationCleanupService {
  constructor(
    private readonly prisma: Pick<PrismaService, "$transaction">,
    private readonly credentials: CustomerConsentCredentials,
    private readonly mode: "FIXTURE_ONLY",
  ) {}
  async end(sessionToken: string) {
    const claims = this.credentials.verifySession(sessionToken);
    const scope = {
      tenantId: claims.tenantId,
      conversationId: claims.conversationId,
      sessionId: claims.sessionId,
    };
    await this.close(scope, true);
    let cleanupPending = false;
    try {
      await this.purge(scope);
    } catch {
      cleanupPending = true;
    }
    return {
      state: "CLOSED" as const,
      cleanupPending,
      fixtureOnly: true,
      deliveryAuthorized: false,
    };
  }
  async sweep(
    tenantId: string,
    afterId = "00000000-0000-4000-8000-000000000000",
    limit = 50,
  ) {
    if (
      this.mode !== "FIXTURE_ONLY" ||
      !UUID.test(tenantId) ||
      !UUID.test(afterId) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new ConflictException();
    const rows = await this.prisma.$transaction((tx) =>
      tx.$queryRaw<{ id: string; sessionId: string }[]>(Prisma.sql`
      SELECT id, "collectedData"->>'sessionId' AS "sessionId" FROM "Conversation"
      WHERE "tenantId"=${tenantId}::uuid AND id>${afterId}::uuid AND channel='WEBCHAT'
      AND "collectedData"->'customerSessionVersion'='1'::jsonb
      AND "collectedData" ? 'verificationLifecycle'
      AND "collectedData"#>'{verificationLifecycle,purgedAt}'='null'::jsonb
      ORDER BY id LIMIT ${limit}`),
    );
    let purged = 0,
      pending = 0;
    for (const row of rows) {
      const scope = {
        tenantId,
        conversationId: row.id,
        sessionId: row.sessionId,
      };
      try {
        if (await this.close(scope, false)) {
          await this.purge(scope);
          purged++;
        }
      } catch {
        pending++;
      }
    }
    return {
      scanned: rows.length,
      purged,
      pending,
      nextCursor: rows.length === limit ? rows.at(-1)!.id : null,
    };
  }
  private async read(tx: Prisma.TransactionClient, scope: Scope) {
    if (
      this.mode !== "FIXTURE_ONLY" ||
      !Object.values(scope).every((v) => typeof v === "string" && UUID.test(v))
    )
      throw new ConflictException();
    await lockConversationSession(tx, scope.tenantId, scope.sessionId);
    const row = await tx.conversation.findUnique({
      where: {
        id_tenantId: { id: scope.conversationId, tenantId: scope.tenantId },
      },
    });
    if (
      !row ||
      row.channel !== "WEBCHAT" ||
      !row.collectedData ||
      typeof row.collectedData !== "object" ||
      Array.isArray(row.collectedData)
    )
      throw new ConflictException();
    const data = row.collectedData;
    if (data.sessionId !== scope.sessionId || data.customerSessionVersion !== 1)
      throw new ConflictException();
    const state = lifecycle(data.verificationLifecycle);
    const [clock] = await tx.$queryRaw<{ ms: bigint }[]>(
      Prisma.sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms`,
    );
    const now = Number(clock?.ms);
    if (!state || !Number.isSafeInteger(now)) throw new ConflictException();
    return { row, data, state, now };
  }
  private async close(scope: Scope, explicit: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const { row, data, state, now } = await this.read(tx, scope);
      if (
        !explicit &&
        row.status === "ONGOING" &&
        !sessionCleanupDue(state, now)
      )
        return false;
      if (state.closedAt === null) {
        state.closedAt = now;
        await tx.conversation.update({
          where: { id: row.id },
          data: { collectedData: { ...data, verificationLifecycle: state } },
        });
        await this.audit(tx, scope, "closed");
      }
      return true;
    });
  }
  private async purge(scope: Scope) {
    return this.prisma.$transaction(async (tx) => {
      const { row, data, state, now } = await this.read(tx, scope);
      if (state.closedAt === null || !sessionCleanupDue(state, now))
        throw new ConflictException();
      if (state.purgedAt !== null) return;
      // Submitted reviews/jobs are business records. Never delete their payloads.
      const submitted = await tx.communicationContent.count({
        where: {
          tenantId: scope.tenantId,
          communicationEvent: {
            conversationId: scope.conversationId,
            conversationTenantId: scope.tenantId,
          },
          payload: { path: ["type"], equals: "protected_intake_review_v1" },
        },
      });
      const linked = await tx.conversationJobLink.count({
        where: {
          tenantId: scope.tenantId,
          conversationId: scope.conversationId,
        },
      });
      if (!submitted && !linked) {
        // Only abandoned protected draft turns; expiry is earlier than seven days.
        await tx.communicationContent.deleteMany({
          where: {
            tenantId: scope.tenantId,
            communicationEvent: {
              conversationId: scope.conversationId,
              conversationTenantId: scope.tenantId,
            },
            payload: { path: ["type"], equals: "protected_intake_turn_v1" },
            AND: [
              { payload: { path: ["sessionId"], equals: scope.sessionId } },
              {
                OR: [
                  { payload: { path: ["version"], equals: 1 } },
                  { payload: { path: ["version"], equals: 2 } },
                ],
              },
            ],
          },
        });
      }
      // Verification-only encrypted payloads are not payment/accounting records.
      delete data.verificationOperations;
      delete data.localPhone;
      delete data.localAddress;
      state.purgedAt = now;
      await tx.conversation.update({
        where: { id: row.id },
        data: { collectedData: { ...data, verificationLifecycle: state } },
      });
      await this.audit(tx, scope, "purged");
    });
  }
  /** Only safely cancelled, never-dispatched request aliases have a supported resolution.
   * Preserve core operation rows, all monetary holds, request counters and audits.
   */
  async purgeResolvedReferences(tenantId: string, limit = 50) {
    if (
      this.mode !== "FIXTURE_ONLY" ||
      !UUID.test(tenantId) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new ConflictException();
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          state: string;
          heldMicros: bigint;
          attemptId: string | null;
          resolvedMs: bigint;
          nowMs: bigint;
        }[]
      >(Prisma.sql`
        SELECT o.id,o.state,o."heldMicros",o."attemptId",
        floor(extract(epoch FROM max(a."createdAt"))*1000)::bigint AS "resolvedMs",
        floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS "nowMs"
        FROM "AddressVerificationOperation" o JOIN "AuditLog" a ON a."tenantId"=o."tenantId"
        AND a.action='conversation.address_operation_cancelled' AND a.metadata->>'operationId'=o.id::text
        WHERE o."tenantId"=${tenantId}::uuid AND o.state='CANCELLED' AND o."heldMicros"=0 AND o."attemptId" IS NULL
        AND EXISTS (SELECT 1 FROM "AddressVerificationRequest" r WHERE r."operationId"=o.id)
        GROUP BY o.id HAVING max(a."createdAt") <= clock_timestamp() - interval '90 days'
        ORDER BY o.id LIMIT ${limit}`);
      let removed = 0;
      for (const row of rows)
        if (
          resolvedReferenceDue(
            row.state,
            row.heldMicros,
            row.attemptId,
            Number(row.resolvedMs),
            Number(row.nowMs),
          )
        ) {
          const count = await tx.addressVerificationRequest.deleteMany({
            where: {
              operationId: row.id,
              operation: {
                tenantId,
                state: "CANCELLED",
                heldMicros: 0n,
                attemptId: null,
              },
            },
          });
          if (count.count) {
            removed += count.count;
            await tx.auditLog.create({
              data: {
                tenantId,
                entityType: "AddressVerificationOperation",
                entityId: row.id,
                actorType: "SYSTEM_AI",
                actorId: "fixture-cleanup",
                action: "conversation.address_references_purged",
                metadata: { count: count.count },
              },
            });
          }
        }
      return { removed };
    });
  }
  private async audit(
    tx: Prisma.TransactionClient,
    scope: Scope,
    state: string,
  ) {
    await tx.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        entityType: "Conversation",
        entityId: scope.conversationId,
        actorType: "SYSTEM_AI",
        actorId: "fixture-cleanup",
        action: "conversation.verification_session_" + state,
        metadata: { sessionId: scope.sessionId },
      },
    });
  }
}
