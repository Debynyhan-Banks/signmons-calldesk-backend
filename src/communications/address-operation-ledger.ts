import { ConflictException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { getRequestContext } from "../common/context/request-context";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import {
  CustomerSessionScope,
  lockCustomerConsentSession,
} from "./customer-consent-session-lock";

type Limit = { micros: number; requests: number };
export type AddressOperationPolicy = {
  mode: "FIXTURE_ONLY";
  approved: true;
  version: string;
  rateVersion: string;
  validUntil: number;
  costMicros: number;
  account: Limit;
  tenant: Limit;
  session: Limit;
  execution?: "VO2_FIXTURE_8S_3_ATTEMPTS_30S";
};
export type AddressOperationBinding = {
  // Trusted immutable input reference: never browser-supplied or reused for edits.
  intentId: string;
  revision: number;
  policy: AddressOperationPolicy;
};
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const refuse = () => new ConflictException("Address operation unavailable.");
// Epoch avoids session-timezone-dependent raw timestamp decoding in the adapter.
async function databaseClock(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<{ ms: bigint }[]>(
    Prisma.sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms`,
  );
  const ms = Number(row?.ms);
  if (!Number.isSafeInteger(ms)) throw refuse();
  return new Date(ms);
}

/** Disabled by default; no route, DI, provider or worker. readBinding runs under
 * the session lock and must read current server-owned intent/policy authority.
 * No address or input digest is accepted or persisted. Production binding and
 * retention are separate gates. All prior holds/counts remain across months.
 */
export class AddressOperationLedger {
  constructor(
    private readonly prisma: Pick<PrismaService, "$transaction">,
    private readonly credentials: CustomerConsentCredentials,
    private readonly fixture?: {
      accountId: string;
      readBinding: (
        tx: Prisma.TransactionClient,
        scope: CustomerSessionScope,
      ) => Promise<AddressOperationBinding | null>;
      recoveryEvidence?: (
        tx: Prisma.TransactionClient,
        evidenceId: string,
      ) => Promise<{
        operationId: string;
        attemptId: string;
        decision: "RETAIN_LIABILITY";
      } | null>;
    },
  ) {}

  async execute(input: {
    sessionToken: string;
    requestId: string;
    action: "reserve" | "claim" | "cancel";
  }) {
    return this.perform(input);
  }

  async complete(input: {
    sessionToken: string;
    requestId: string;
    attemptId: string;
    state: "OBSERVED" | "UNCERTAIN";
  }) {
    if (
      !input ||
      Object.keys(input).sort().join(",") !==
        "attemptId,requestId,sessionToken,state" ||
      !uuid(input.attemptId) ||
      !["OBSERVED", "UNCERTAIN"].includes(input.state)
    )
      throw refuse();
    return this.perform(
      {
        sessionToken: input.sessionToken,
        requestId: input.requestId,
        action: "claim",
      },
      { attemptId: input.attemptId, state: input.state },
    );
  }

  private async perform(
    input: {
      sessionToken: string;
      requestId: string;
      action: "reserve" | "claim" | "cancel";
    },
    completion?: { attemptId: string; state: "OBSERVED" | "UNCERTAIN" },
  ) {
    if (
      !input ||
      Object.keys(input).sort().join(",") !== "action,requestId,sessionToken" ||
      !["reserve", "claim", "cancel"].includes(input.action) ||
      !uuid(input.requestId) ||
      typeof input.sessionToken !== "string" ||
      input.sessionToken.length > 4096 ||
      !this.fixture ||
      !uuid(this.fixture.accountId)
    )
      throw refuse();
    input = { ...input };
    const scope = this.credentials.verifySession(input.sessionToken);
    const ctx = getRequestContext();
    if (
      ctx?.tenantId !== scope.tenantId ||
      ctx.role !== "webchat_integration" ||
      !ctx.userId?.startsWith("integration:") ||
      ctx.impersonatedTenantId
    )
      throw refuse();
    const fixture = { ...this.fixture };
    return this.prisma.$transaction(async (tx) => {
      for (const key of [
        "address-account:" + fixture.accountId,
        "address-tenant:" + scope.tenantId,
      ])
        await tx.$queryRaw(
          Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${key},0))`,
        );
      if ((await lockCustomerConsentSession(tx, scope)).status !== "ONGOING")
        throw refuse();
      const binding = structuredClone(await fixture.readBinding(tx, scope));
      const clock = { now: await databaseClock(tx) };
      const now = clock?.now?.getTime();
      if (
        !binding ||
        !uuid(binding.intentId) ||
        !Number.isSafeInteger(binding.revision) ||
        binding.revision < 1 ||
        binding.revision > 2147483647 ||
        !Number.isFinite(now)
      )
        throw refuse();
      const p = binding.policy;
      if (
        !p ||
        p.mode !== "FIXTURE_ONLY" ||
        p.approved !== true ||
        (p.execution !== undefined &&
          p.execution !== "VO2_FIXTURE_8S_3_ATTEMPTS_30S") ||
        !Number.isFinite(p.validUntil) ||
        p.validUntil <= now ||
        ![p.version, p.rateVersion].every(
          (v) => typeof v === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(v),
        ) ||
        !Number.isSafeInteger(p.costMicros) ||
        p.costMicros <= 0 ||
        ![p.account, p.tenant, p.session].every(
          (l) =>
            l &&
            Number.isSafeInteger(l.micros) &&
            l.micros >= p.costMicros &&
            Number.isSafeInteger(l.requests) &&
            l.requests >= 1 &&
            l.requests <= 10000,
        )
      )
        throw refuse();
      // Explicit field order; this digest covers policy only, never customer input.
      const policyHash = createHash("sha256")
        .update(
          JSON.stringify([
            p.version,
            p.rateVersion,
            p.validUntil,
            p.costMicros,
            p.account.micros,
            p.account.requests,
            p.tenant.micros,
            p.tenant.requests,
            p.session.micros,
            p.session.requests,
            ...(p.execution ? [p.execution] : []),
          ]),
        )
        .digest("hex");
      const where = {
        accountId: fixture.accountId,
        tenantId: scope.tenantId,
        conversationId: scope.conversationId,
        sessionId: scope.sessionId,
        intentId: binding.intentId,
        revision: binding.revision,
        policyHash,
      };
      const alias = await tx.addressVerificationRequest.findUnique({
        where: { id: input.requestId },
        include: { operation: true },
      });
      let operation = alias?.operation ?? null;
      if (
        operation &&
        Object.entries(where).some(
          ([k, v]) => operation![k as keyof typeof operation] !== v,
        )
      )
        throw refuse();
      if (!operation) {
        if (input.action !== "reserve") throw refuse();
        operation = await tx.addressVerificationOperation.findFirst({ where });
        if (!operation) {
          if (p.execution) {
            const prior = await tx.addressVerificationOperation.findMany({
              where: {
                accountId: fixture.accountId,
                tenantId: scope.tenantId,
                sessionId: scope.sessionId,
              },
              orderBy: { createdAt: "desc" },
              take: 3,
            });
            if (
              prior.length >= 3 ||
              (prior[0] && now - prior[0].createdAt.getTime() < 30000)
            )
              throw refuse();
          }
          for (const [filter, limit] of [
            [{ accountId: fixture.accountId }, p.account],
            [
              { accountId: fixture.accountId, tenantId: scope.tenantId },
              p.tenant,
            ],
            [
              {
                accountId: fixture.accountId,
                tenantId: scope.tenantId,
                sessionId: scope.sessionId,
              },
              p.session,
            ],
          ] as const) {
            const total = await tx.addressVerificationOperation.aggregate({
              where: filter,
              _sum: { heldMicros: true },
              _count: true,
            });
            if (
              total._count >= limit.requests ||
              (total._sum.heldMicros ?? 0n) + BigInt(p.costMicros) >
                BigInt(limit.micros)
            )
              throw refuse();
          }
          operation = await tx.addressVerificationOperation.create({
            data: {
              ...where,
              id: randomUUID(),
              createdAt: clock.now,
              heldMicros: BigInt(p.costMicros),
            },
          });
          await this.audit(tx, scope, operation.id, "reserved");
        }
        // Bound aliases too; repeated UUIDs cannot grow storage without limit.
        if (
          (await tx.addressVerificationRequest.count({
            where: { operationId: operation.id },
          })) >= 20
        )
          throw refuse();
        await tx.addressVerificationRequest.create({
          data: { id: input.requestId, operationId: operation.id },
        });
      }
      let claimed = false;
      let completed = false;
      if (completion) {
        if (
          !p.execution ||
          operation.attemptId !== completion.attemptId ||
          !operation.executionDeadline
        )
          throw refuse();
        if (operation.state === "DISPATCH_CLAIMED") {
          operation = await tx.addressVerificationOperation.update({
            where: { id: operation.id },
            data: {
              state:
                now >= operation.executionDeadline.getTime()
                  ? "UNCERTAIN"
                  : completion.state,
            },
          });
          await this.audit(tx, scope, operation.id, "observed");
          completed = true;
        }
      } else if (input.action === "claim" && operation.state === "RESERVED") {
        operation = await tx.addressVerificationOperation.update({
          where: { id: operation.id },
          data: {
            state: "DISPATCH_CLAIMED",
            attemptId: randomUUID(),
            executionDeadline: p.execution
              ? new Date(Math.min(now + 8000, p.validUntil, scope.expiresAt))
              : null,
          },
        });
        await this.audit(tx, scope, operation.id, "claimed");
        claimed = true;
      } else if (input.action === "cancel") {
        if (!["RESERVED", "CANCELLED"].includes(operation.state))
          throw refuse();
        if (operation.state === "RESERVED") {
          operation = await tx.addressVerificationOperation.update({
            where: { id: operation.id },
            data: { state: "CANCELLED", heldMicros: 0n },
          });
          await this.audit(tx, scope, operation.id, "cancelled");
        }
      }
      this.credentials.verifySession(input.sessionToken);
      const finished = { now: await databaseClock(tx) };
      if (
        !Number.isFinite(finished?.now?.getTime()) ||
        finished.now.getTime() >= p.validUntil
      )
        throw refuse();
      if (
        completed &&
        operation.state === "OBSERVED" &&
        operation.executionDeadline &&
        finished.now.getTime() >= operation.executionDeadline.getTime()
      ) {
        operation = await tx.addressVerificationOperation.update({
          where: { id: operation.id },
          data: { state: "UNCERTAIN" },
        });
      }
      return {
        operationId: operation.id,
        state: operation.state,
        claimed,
        completed,
        attemptId: operation.attemptId,
        executionDeadline: operation.executionDeadline?.getTime() ?? null,
        fixtureOnly: true,
        dispatchAuthorized: false,
        addressVerified: false,
        admissionAuthorized: false,
        county: "UNKNOWN",
        deliveryAuthorized: false,
      } as const;
    });
  }

  /** Inactive operator recovery: retain liability only. No refund, resend or proof.
   * Evidence must be resolved server-side, not accepted as a customer assertion.
   */
  async recover(input: {
    operationId: string;
    attemptId: string;
    evidenceId: string;
  }) {
    const ctx = getRequestContext();
    const fixture = this.fixture;
    if (
      !input ||
      Object.keys(input).sort().join(",") !==
        "attemptId,evidenceId,operationId" ||
      ![input.operationId, input.attemptId, input.evidenceId].every(uuid) ||
      !ctx ||
      !uuid(ctx.tenantId) ||
      !uuid(ctx.userId) ||
      !["owner", "admin"].includes(ctx.role ?? "") ||
      ctx.impersonatedTenantId ||
      !fixture?.recoveryEvidence ||
      !uuid(fixture.accountId)
    )
      throw refuse();
    const actorId = ctx.userId,
      tenantId = ctx.tenantId;
    input = { ...input };
    return this.prisma.$transaction(async (tx) => {
      for (const key of [
        "address-account:" + fixture.accountId,
        "address-tenant:" + tenantId,
      ])
        await tx.$queryRaw(
          Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${key},0))`,
        );
      const tenant = await tx.tenantOrganization.findUnique({
        where: { id: tenantId },
        select: { status: true },
      });
      if (tenant?.status !== "ACTIVE") throw refuse();
      const row = await tx.addressVerificationOperation.findFirst({
        where: {
          id: input.operationId,
          tenantId,
          accountId: fixture.accountId,
        },
      });
      const evidence = structuredClone(
        await fixture.recoveryEvidence!(tx, input.evidenceId),
      );
      const clock = { now: await databaseClock(tx) };
      if (
        !row ||
        row.attemptId !== input.attemptId ||
        !row.executionDeadline ||
        !Number.isFinite(clock?.now?.getTime()) ||
        clock.now.getTime() < row.executionDeadline.getTime() ||
        !evidence ||
        evidence.operationId !== row.id ||
        evidence.attemptId !== row.attemptId ||
        evidence.decision !== "RETAIN_LIABILITY" ||
        !["DISPATCH_CLAIMED", "UNCERTAIN"].includes(row.state)
      )
        throw refuse();
      const action = "conversation.address_operation_recovered";
      const prior = await tx.auditLog.findFirst({
        where: {
          tenantId,
          action,
          metadata: { path: ["operationId"], equals: row.id },
        },
      });
      if (prior) {
        const meta = prior.metadata as Record<string, unknown>;
        if (
          prior.actorId !== actorId ||
          meta.evidenceId !== input.evidenceId ||
          meta.attemptId !== input.attemptId
        )
          throw refuse();
      } else {
        await tx.addressVerificationOperation.update({
          where: { id: row.id },
          data: { state: "UNCERTAIN" },
        });
        await tx.auditLog.create({
          data: {
            tenantId,
            entityType: "Conversation",
            entityId: row.conversationId,
            actorType: "USER",
            actorId,
            action,
            metadata: {
              version: 1,
              operationId: row.id,
              attemptId: row.attemptId,
              evidenceId: input.evidenceId,
              decision: "RETAIN_LIABILITY",
              fixtureOnly: true,
            },
          },
        });
      }
      return {
        state: "UNCERTAIN",
        liabilityRetained: true,
        dispatchAuthorized: false,
        admissionAuthorized: false,
      } as const;
    });
  }
  private audit(
    tx: Prisma.TransactionClient,
    scope: CustomerSessionScope,
    id: string,
    transition: string,
  ) {
    return tx.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        entityType: "Conversation",
        entityId: scope.conversationId,
        actorType: "CUSTOMER",
        actorId: "address-operation-session",
        action: "conversation.address_operation_" + transition,
        metadata: { version: 1, operationId: id, fixtureOnly: true },
      },
    });
  }
}
