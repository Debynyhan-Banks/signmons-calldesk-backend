import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CustomerSessionScope } from "./customer-consent-session-lock";

export type VerificationOptIn = { requested: true; noticeVersion: string };
export interface VerificationAdmission {
  lock(tx: Prisma.TransactionClient, tenantId: string): Promise<void>;
  reserve(
    tx: Prisma.TransactionClient,
    scope: CustomerSessionScope,
    operationId: string,
    phoneDigest: string,
    optIn?: VerificationOptIn,
  ): Promise<void>;
  check(
    tx: Prisma.TransactionClient,
    scope: CustomerSessionScope,
    startId: string,
    phoneDigest: string,
  ): Promise<void>;
}

// Approved policy, not a configured provider budget or subscription entitlement.
export const VERIFICATION_BUDGET_USD_MICROS = 50_000_000;
const ACTION = "conversation.verification_budget_reserved";
type FixturePolicy = {
  mode: "FIXTURE_ONLY";
  tenantId: string;
  noticeVersion: string;
  noticeText: string;
  termsUrl: string;
  privacyUrl: string;
  rateVersion: string;
  flowUpperBoundUsdMicros: number;
};
const refuse = () =>
  new ConflictException("Verification consent or budget is unavailable.");

/** Inactive proof implementation. Audit reservations are never released automatically.
 * Lock before the conversation lock; reserve in the SAME transaction as the operation.
 * No production rate source, reconciliation, alert delivery or provider bootstrap.
 */
export class VerificationBudgetAdmission implements VerificationAdmission {
  private readonly policy?: FixturePolicy;
  constructor(policy?: FixturePolicy) {
    this.policy = policy ? structuredClone(policy) : undefined;
  }
  async lock(tx: Prisma.TransactionClient, tenantId: string) {
    await tx.$queryRaw(
      Prisma.sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${"verification-budget:" + tenantId}, 0))`,
    );
  }
  async reserve(
    tx: Prisma.TransactionClient,
    scope: CustomerSessionScope,
    operationId: string,
    phoneDigest: string,
    optIn?: VerificationOptIn,
  ) {
    const p = this.policy;
    if (
      !p ||
      p.mode !== "FIXTURE_ONLY" ||
      p.tenantId !== scope.tenantId ||
      !p.noticeVersion ||
      !p.noticeText ||
      !p.termsUrl.startsWith("https://") ||
      !p.privacyUrl.startsWith("https://") ||
      !p.rateVersion ||
      !Number.isSafeInteger(p.flowUpperBoundUsdMicros) ||
      p.flowUpperBoundUsdMicros <= 0 ||
      p.flowUpperBoundUsdMicros > VERIFICATION_BUDGET_USD_MICROS ||
      !optIn ||
      Object.keys(optIn).sort().join(",") !== "noticeVersion,requested" ||
      optIn.requested !== true ||
      optIn.noticeVersion !== p.noticeVersion
    )
      throw refuse();
    const rows = await tx.auditLog.findMany({
      where: { tenantId: scope.tenantId, action: ACTION },
      take: 10001,
    });
    // All entries are unresolved liabilities, including earlier months. No reset erases them.
    if (rows.length > 10000) throw refuse();
    let held = 0;
    for (const row of rows) {
      const m = row.metadata as Record<string, unknown> | null;
      if (
        !m ||
        m.version !== 1 ||
        m.currency !== "USD" ||
        m.state !== "HELD" ||
        !Number.isSafeInteger(m.reservedMicros) ||
        (m.reservedMicros as number) <= 0
      )
        throw refuse();
      held += m.reservedMicros as number;
      if (!Number.isSafeInteger(held)) throw refuse();
    }
    const total = held + p.flowUpperBoundUsdMicros;
    if (total > VERIFICATION_BUDGET_USD_MICROS) throw refuse();
    const [clock] = await tx.$queryRaw<{ now: Date }[]>(
      Prisma.sql`SELECT clock_timestamp() AS now`,
    );
    if (!(clock?.now instanceof Date) || !Number.isFinite(clock.now.getTime()))
      throw refuse();
    await tx.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        entityType: "Conversation",
        entityId: scope.conversationId,
        actorType: "CUSTOMER",
        actorId: "verification-session",
        action: ACTION,
        metadata: {
          version: 1,
          mode: "FIXTURE_ONLY",
          operationId,
          sessionId: scope.sessionId,
          phoneDigest,
          requested: true,
          noticeVersion: p.noticeVersion,
          noticeText: p.noticeText,
          termsUrl: p.termsUrl,
          privacyUrl: p.privacyUrl,
          requestedAt: clock.now.toISOString(),
          monthUtc: clock.now.toISOString().slice(0, 7),
          rateVersion: p.rateVersion,
          currency: "USD",
          reservedMicros: p.flowUpperBoundUsdMicros,
          state: "HELD",
          ceilingMicros: VERIFICATION_BUDGET_USD_MICROS,
          crossedAlertMicros: [25_000_000, 40_000_000].filter(
            (n) => held < n && total >= n,
          ),
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
    const rows = await tx.auditLog.findMany({
      where: {
        tenantId: scope.tenantId,
        entityId: scope.conversationId,
        action: ACTION,
        metadata: { path: ["operationId"], equals: startId },
      },
      take: 2,
    });
    const m = rows[0]?.metadata as Record<string, unknown> | undefined;
    if (
      rows.length !== 1 ||
      !m ||
      m.version !== 1 ||
      m.state !== "HELD" ||
      m.mode !== "FIXTURE_ONLY" ||
      m.requested !== true ||
      m.currency !== "USD" ||
      m.sessionId !== scope.sessionId ||
      m.phoneDigest !== phoneDigest ||
      !Number.isSafeInteger(m.reservedMicros) ||
      (m.reservedMicros as number) <= 0
    )
      throw refuse();
  }
}
