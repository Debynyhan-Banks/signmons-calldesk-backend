import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  CustomerBrowserBudget,
  CustomerBrowserOperation,
  CustomerBrowserRelease,
} from "./customer-consent-browser-budget";

export type SharedBrowserPolicy = {
  packetId: string;
  tenantId: string;
  validFrom: number;
  validUntil: number;
  total: number;
  tenant: number;
  session: number;
  starts: number;
  inFlight: number;
};
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const entityType = "ControlledBrowserBudgetV1";

/** Inactive packet-scoped HTTP limits, NOT provider-spend permission.
 * Append-only events contain internal IDs only. Crashes retain reservations. */
export class SharedCustomerBrowserBudget implements CustomerBrowserBudget {
  private readonly policy?: Readonly<SharedBrowserPolicy>;
  private readonly digest: string;
  constructor(
    private readonly prisma: Pick<PrismaService, "$transaction">,
    policy?: SharedBrowserPolicy,
  ) {
    this.policy = policy ? Object.freeze({ ...policy }) : undefined;
    this.digest = createHash("sha256")
      .update(
        JSON.stringify(
          policy
            ? Object.entries(policy).sort(([a], [b]) => a.localeCompare(b))
            : null,
        ),
      )
      .digest("hex");
  }
  private valid() {
    const p = this.policy;
    return (
      !!p &&
      Object.keys(p).sort().join() ===
        "inFlight,packetId,session,starts,tenant,tenantId,total,validFrom,validUntil" &&
      uuid(p.packetId) &&
      uuid(p.tenantId) &&
      Number.isSafeInteger(p.validFrom) &&
      Number.isSafeInteger(p.validUntil) &&
      p.validUntil > p.validFrom &&
      p.validUntil - p.validFrom <= 900000 &&
      [p.total, p.tenant, p.session, p.starts, p.inFlight].every(
        (n) => Number.isSafeInteger(n) && n > 0 && n <= 1000,
      ) &&
      p.tenant <= p.total &&
      p.session <= p.tenant &&
      p.starts <= p.total &&
      p.inFlight <= p.total
    );
  }
  private async transaction<T>(
    fn: (
      tx: Prisma.TransactionClient,
      rows: { action: string; metadata: Prisma.JsonValue }[],
      now: number,
    ) => Promise<T>,
  ) {
    if (!this.valid()) throw Error("Unavailable");
    const p = this.policy!;
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${entityType + p.packetId}, 0))`,
        );
        const [clock] = await tx.$queryRaw<{ ms: bigint }[]>(
          Prisma.sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms`,
        );
        const now = Number(clock?.ms);
        if (
          !Number.isSafeInteger(now) ||
          now < p.validFrom ||
          now >= p.validUntil
        )
          throw Error("Unavailable");
        const rows = await tx.auditLog.findMany({
          where: { entityType, entityId: p.packetId },
          select: { action: true, metadata: true },
          take: 3001,
        });
        if (
          rows.length > 3000 ||
          rows.some((r) => this.meta(r.metadata).policy !== this.digest)
        )
          throw Error("Unavailable");
        return fn(tx, rows, now);
      },
      { maxWait: 2000, timeout: 4000 },
    );
  }
  private meta(value: Prisma.JsonValue): Prisma.JsonObject {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  }
  private async append(
    tx: Prisma.TransactionClient,
    action: string,
    id: string,
    sessionId?: string,
  ) {
    const p = this.policy!;
    await tx.auditLog.create({
      data: {
        tenantId: p.tenantId,
        entityType,
        entityId: p.packetId,
        actorType: "SYSTEM_AI",
        actorId: "controlled-browser-budget",
        action,
        metadata: {
          policy: this.digest,
          requestId: id,
          ...(sessionId ? { sessionId } : {}),
        },
      },
    });
  }
  async acquire(
    _peer: string,
    operation: CustomerBrowserOperation,
  ): Promise<CustomerBrowserRelease | null> {
    if (
      ![
        "start",
        "end",
        "capture",
        "prompt",
        "respond",
        "continue",
        "draft",
        "submit",
        "phone",
        "verify",
        "address",
        "correction",
        "sms",
      ].includes(operation)
    )
      return null;
    const id = randomUUID();
    try {
      const admitted = await this.transaction(async (tx, rows) => {
        const reserved = rows.filter(
          (r) => r.action === "reserve" || r.action === "start",
        );
        const released = new Set(
          rows
            .filter((r) => r.action === "release")
            .map((r) => this.meta(r.metadata).requestId),
        );
        const p = this.policy!;
        if (
          reserved.length >= Math.min(p.total, p.tenant) ||
          reserved.filter((r) => !released.has(this.meta(r.metadata).requestId))
            .length >= p.inFlight ||
          (operation === "start" &&
            rows.filter((r) => r.action === "start").length >= p.starts)
        )
          return false;
        await this.append(tx, operation === "start" ? "start" : "reserve", id);
        return true;
      });
      if (!admitted) return null;
      const release: CustomerBrowserRelease = async () => {
        try {
          await this.transaction(async (tx, rows) => {
            if (
              !rows.some(
                (r) =>
                  r.action === "release" &&
                  this.meta(r.metadata).requestId === id,
              )
            )
              await this.append(tx, "release", id);
          });
        } catch {
          /* Retain held slot, never change caller outcome. */
        }
      };
      release.bindSession = async (sessionId) => {
        if (!uuid(sessionId)) return false;
        try {
          return await this.transaction(async (tx, rows) => {
            const own = rows.filter(
              (r) => this.meta(r.metadata).requestId === id,
            );
            if (own.some((r) => r.action === "release")) return false;
            const binding = own.find((r) => r.action === "session");
            if (binding)
              return this.meta(binding.metadata).sessionId === sessionId;
            if (
              rows.filter(
                (r) =>
                  r.action === "session" &&
                  this.meta(r.metadata).sessionId === sessionId,
              ).length >= this.policy!.session
            )
              return false;
            await this.append(tx, "session", id, sessionId);
            return true;
          });
        } catch {
          return false;
        }
      };
      return release;
    } catch {
      return null;
    }
  }
}
