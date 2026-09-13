import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CustomerSessionScope } from "./customer-consent-session-lock";
import {
  VerificationAdmission,
  VerificationOptIn,
} from "./verification-budget-admission";
import { StagingPhonePolicy, stagingPhoneDigest } from "./staging-phone-policy";

export const STAGING_PHONE_HOLD = "conversation.staging_phone_held";
const deny = () =>
  new ConflictException("Staging phone approval is unavailable.");

/** Same transaction as durable operation reservation; all held flows count forever.
 * This bounds this staging path, not unrelated account traffic or an invoice.
 */
export class StagingPhoneAdmission implements VerificationAdmission {
  constructor(private readonly policy: StagingPhonePolicy) {}
  replay(
    tx: Prisma.TransactionClient,
    scope: CustomerSessionScope,
    startId: string,
    phoneDigest: string,
  ) {
    return this.check(tx, scope, startId, phoneDigest);
  }
  async lock(tx: Prisma.TransactionClient, tenantId: string) {
    if (tenantId !== this.policy.tenantId) throw deny();
    await tx.$queryRaw(
      Prisma.sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${"staging-phone:" + this.policy.accountSid}, 0))`,
    );
    await this.current(tx);
  }
  async current(tx: Prisma.TransactionClient) {
    const p = this.policy;
    const rows = await tx.$queryRaw<
      { settings: Prisma.JsonValue; nowMs: bigint }[]
    >(Prisma.sql`
      SELECT settings, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs"
      FROM "TenantOrganization" WHERE id=${p.tenantId}::uuid AND status='ACTIVE' FOR SHARE`);
    const row = rows[0];
    const settings = row?.settings as Record<string, unknown> | null;
    const approval = settings?.stagingPhoneTestApproval as
      | Record<string, unknown>
      | undefined;
    const now = Number(row?.nowMs);
    if (
      rows.length !== 1 ||
      !Number.isSafeInteger(now) ||
      now < p.startsAt ||
      now >= p.expiresAt ||
      approval?.enabled !== true ||
      approval.digest !== stagingPhoneDigest(p)
    )
      throw deny();
  }
  private scope(scope: CustomerSessionScope, phoneDigest: string) {
    const p = this.policy;
    if (
      scope.tenantId !== p.tenantId ||
      scope.sessionId !== p.sessionId ||
      scope.conversationId !== p.conversationId ||
      phoneDigest !== p.phoneDigest
    )
      throw deny();
  }
  async reserve(
    tx: Prisma.TransactionClient,
    scope: CustomerSessionScope,
    operationId: string,
    phoneDigest: string,
    optIn?: VerificationOptIn,
  ) {
    this.scope(scope, phoneDigest);
    const p = this.policy;
    if (
      !optIn ||
      Object.keys(optIn).sort().join(",") !== "noticeVersion,requested" ||
      optIn.requested !== true ||
      optIn.noticeVersion !== p.noticeVersion
    )
      throw deny();
    const rows = await tx.auditLog.findMany({
      where: {
        action: STAGING_PHONE_HOLD,
        metadata: { path: ["accountSid"], equals: p.accountSid },
      },
      take: 4,
    });
    if (rows.length >= 3) throw deny();
    let held = 0;
    for (const row of rows) {
      const m = row.metadata as Record<string, unknown>;
      if (
        !m ||
        m.version !== 1 ||
        m.state !== "HELD" ||
        m.currency !== "USD" ||
        !Number.isSafeInteger(m.reservedMicros) ||
        Number(m.reservedMicros) <= 0 ||
        m.sessionId === p.sessionId
      )
        throw deny();
      held += Number(m.reservedMicros);
    }
    if (!Number.isSafeInteger(held) || held + p.flowUpperBoundMicros > 500_000)
      throw deny();
    await tx.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        entityType: "Conversation",
        entityId: scope.conversationId,
        actorType: "USER",
        actorId: p.operatorId,
        action: STAGING_PHONE_HOLD,
        metadata: {
          version: 1,
          state: "HELD",
          currency: "USD",
          reservedMicros: p.flowUpperBoundMicros,
          accountSid: p.accountSid,
          operationId,
          sessionId: scope.sessionId,
          phoneDigest,
          approvalDigest: stagingPhoneDigest(p),
          noticeVersion: p.noticeVersion,
          rateVersion: p.rateVersion,
        },
      },
    });
  }
  async check(
    tx: Prisma.TransactionClient,
    scope: CustomerSessionScope,
    startId: string,
    phoneDigest: string,
  ) {
    this.scope(scope, phoneDigest);
    const rows = await tx.auditLog.findMany({
      where: {
        tenantId: scope.tenantId,
        entityId: scope.conversationId,
        action: STAGING_PHONE_HOLD,
        metadata: { path: ["operationId"], equals: startId },
      },
      take: 2,
    });
    const m = rows[0]?.metadata as Record<string, unknown> | undefined;
    if (
      rows.length !== 1 ||
      m?.state !== "HELD" ||
      m.approvalDigest !== stagingPhoneDigest(this.policy) ||
      m.phoneDigest !== phoneDigest ||
      m.sessionId !== scope.sessionId ||
      m.reservedMicros !== this.policy.flowUpperBoundMicros
    )
      throw deny();
  }
}
