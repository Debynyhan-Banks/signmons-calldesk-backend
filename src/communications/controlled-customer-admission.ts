import { ConflictException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { CustomerSessionScope } from "./customer-consent-session-lock";
import {
  VerificationAdmission,
  VerificationOptIn,
} from "./verification-budget-admission";
import { STAGING_PHONE_HOLD } from "./staging-phone-admission";

export const CONTROLLED_PHONE_HOLD = "conversation.controlled_phone_held";
export type ControlledCustomerAdmissionPolicy = {
  packetId: string;
  tenantId: string;
  accountSid: string;
  serviceSid: string;
  participantHmac: string;
  noticeVersion: string;
  rateVersion: string;
  startsAt: number;
  expiresAt: number;
  flowUpperBoundMicros: number;
  accountCeilingMicros: number;
};
export function controlledCustomerAdmissionDigest(
  p: ControlledCustomerAdmissionPolicy,
) {
  return createHash("sha256")
    .update(
      JSON.stringify(Object.entries(p).sort(([a], [b]) => a.localeCompare(b))),
    )
    .digest("hex");
}
const deny = () =>
  new ConflictException("Controlled verification approval unavailable.");
const uuid = (v: unknown) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** Inactive customer admission; lock/reserve in durable operation transaction.
 * All historical held liabilities remain counted, regardless of expiry. */
export class ControlledCustomerAdmission implements VerificationAdmission {
  private readonly policy?: Readonly<ControlledCustomerAdmissionPolicy>;
  constructor(policy?: ControlledCustomerAdmissionPolicy) {
    this.policy = policy ? Object.freeze({ ...policy }) : undefined;
  }
  private configured() {
    const p = this.policy;
    if (
      !p ||
      Object.keys(p).sort().join() !==
        "accountCeilingMicros,accountSid,expiresAt,flowUpperBoundMicros,noticeVersion,packetId,participantHmac,rateVersion,serviceSid,startsAt,tenantId" ||
      !uuid(p.packetId) ||
      !uuid(p.tenantId) ||
      !/^AC[0-9a-f]{32}$/i.test(p.accountSid) ||
      !/^VA[0-9a-f]{32}$/i.test(p.serviceSid) ||
      !/^[a-f0-9]{64}$/.test(p.participantHmac) ||
      ![p.noticeVersion, p.rateVersion].every(
        (v) => typeof v === "string" && v.length > 0 && v.length <= 200,
      ) ||
      ![
        p.startsAt,
        p.expiresAt,
        p.flowUpperBoundMicros,
        p.accountCeilingMicros,
      ].every(Number.isSafeInteger) ||
      p.startsAt < 0 ||
      p.expiresAt <= p.startsAt ||
      p.expiresAt - p.startsAt > 900000 ||
      p.flowUpperBoundMicros <= 0 ||
      p.accountCeilingMicros < p.flowUpperBoundMicros
    )
      throw deny();
    return p;
  }
  async lock(tx: Prisma.TransactionClient, tenantId: string) {
    const p = this.configured();
    if (tenantId !== p.tenantId) throw deny();
    await tx.$queryRaw(
      Prisma.sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${"staging-phone:" + p.accountSid}, 0))`,
    );
    const rows = await tx.$queryRaw<
      { settings: Prisma.JsonValue; nowMs: bigint }[]
    >(
      Prisma.sql`SELECT settings, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs" FROM "TenantOrganization" WHERE id=${p.tenantId}::uuid AND status='ACTIVE' FOR SHARE`,
    );
    const row = rows[0],
      now = Number(row?.nowMs);
    const approval = object(object(row?.settings).controlledPhoneApproval);
    if (
      rows.length !== 1 ||
      !Number.isSafeInteger(now) ||
      now < p.startsAt ||
      now >= p.expiresAt ||
      approval.enabled !== true ||
      approval.digest !== controlledCustomerAdmissionDigest(p)
    )
      throw deny();
  }
  private scope(scope: CustomerSessionScope, phoneDigest: string) {
    const p = this.configured();
    if (
      scope.tenantId !== p.tenantId ||
      !uuid(scope.sessionId) ||
      !uuid(scope.conversationId) ||
      phoneDigest !== p.participantHmac
    )
      throw deny();
    return p;
  }
  async reserve(
    tx: Prisma.TransactionClient,
    scope: CustomerSessionScope,
    operationId: string,
    phoneDigest: string,
    optIn?: VerificationOptIn,
  ) {
    const p = this.scope(scope, phoneDigest);
    if (
      !uuid(operationId) ||
      !optIn ||
      Object.keys(optIn).sort().join() !== "noticeVersion,requested" ||
      optIn.requested !== true ||
      optIn.noticeVersion !== p.noticeVersion
    )
      throw deny();
    await this.lock(tx, scope.tenantId);
    const rows = await tx.auditLog.findMany({
      where: {
        action: { in: [STAGING_PHONE_HOLD, CONTROLLED_PHONE_HOLD] },
        metadata: { path: ["accountSid"], equals: p.accountSid },
      },
      take: 10001,
    });
    if (rows.length > 10000) throw deny();
    let held = 0;
    for (const row of rows) {
      const m = object(row.metadata);
      if (
        m.version !== 1 ||
        m.state !== "HELD" ||
        m.currency !== "USD" ||
        !Number.isSafeInteger(m.reservedMicros) ||
        Number(m.reservedMicros) <= 0 ||
        (row.action === CONTROLLED_PHONE_HOLD && m.packetId === p.packetId) ||
        (row.tenantId === scope.tenantId && m.sessionId === scope.sessionId)
      )
        throw deny();
      held += Number(m.reservedMicros);
      if (!Number.isSafeInteger(held)) throw deny();
    }
    if (
      !Number.isSafeInteger(held + p.flowUpperBoundMicros) ||
      held + p.flowUpperBoundMicros > p.accountCeilingMicros
    )
      throw deny();
    await tx.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        entityType: "Conversation",
        entityId: scope.conversationId,
        actorType: "SYSTEM_AI",
        actorId: "controlled-customer-admission",
        action: CONTROLLED_PHONE_HOLD,
        metadata: {
          version: 1,
          state: "HELD",
          currency: "USD",
          reservedMicros: p.flowUpperBoundMicros,
          accountSid: p.accountSid,
          serviceSid: p.serviceSid,
          packetId: p.packetId,
          operationId,
          sessionId: scope.sessionId,
          phoneDigest,
          approvalDigest: controlledCustomerAdmissionDigest(p),
          noticeVersion: p.noticeVersion,
          rateVersion: p.rateVersion,
        },
      },
    });
  }
  replay(
    tx: Prisma.TransactionClient,
    scope: CustomerSessionScope,
    startId: string,
    phoneDigest: string,
  ) {
    return this.check(tx, scope, startId, phoneDigest);
  }
  async check(
    tx: Prisma.TransactionClient,
    scope: CustomerSessionScope,
    startId: string,
    phoneDigest: string,
  ) {
    const p = this.scope(scope, phoneDigest);
    if (!uuid(startId)) throw deny();
    await this.lock(tx, scope.tenantId);
    const rows = await tx.auditLog.findMany({
      where: {
        tenantId: scope.tenantId,
        entityId: scope.conversationId,
        action: CONTROLLED_PHONE_HOLD,
        metadata: { path: ["operationId"], equals: startId },
      },
      take: 2,
    });
    const m = object(rows[0]?.metadata);
    if (
      rows.length !== 1 ||
      m.version !== 1 ||
      m.state !== "HELD" ||
      m.currency !== "USD" ||
      m.accountSid !== p.accountSid ||
      m.serviceSid !== p.serviceSid ||
      m.packetId !== p.packetId ||
      m.approvalDigest !== controlledCustomerAdmissionDigest(p) ||
      m.sessionId !== scope.sessionId ||
      m.phoneDigest !== phoneDigest ||
      m.reservedMicros !== p.flowUpperBoundMicros
    )
      throw deny();
  }
}
