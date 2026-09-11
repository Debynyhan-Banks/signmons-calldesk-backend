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
    },
  ) {}

  async execute(input: {
    sessionToken: string;
    requestId: string;
    action: "reserve" | "claim" | "cancel";
  }) {
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
      const [clock] = await tx.$queryRaw<{ now: Date }[]>(
        Prisma.sql`SELECT clock_timestamp() AS now`,
      );
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
      if (input.action === "claim" && operation.state === "RESERVED") {
        operation = await tx.addressVerificationOperation.update({
          where: { id: operation.id },
          data: { state: "DISPATCH_CLAIMED", attemptId: randomUUID() },
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
      const [finished] = await tx.$queryRaw<{ now: Date }[]>(
        Prisma.sql`SELECT clock_timestamp() AS now`,
      );
      if (
        !Number.isFinite(finished?.now?.getTime()) ||
        finished.now.getTime() >= p.validUntil
      )
        throw refuse();
      return {
        operationId: operation.id,
        state: operation.state,
        claimed,
        fixtureOnly: true,
        dispatchAuthorized: false,
        addressVerified: false,
        admissionAuthorized: false,
        county: "UNKNOWN",
        deliveryAuthorized: false,
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
