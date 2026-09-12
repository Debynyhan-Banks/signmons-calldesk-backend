import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHmac, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { lockCustomerConsentSession } from "./customer-consent-session-lock";
import {
  createVerificationProof,
  sameFreshnessPolicy,
  validFreshnessPolicy,
  verificationProofCurrent,
  type VerificationProof,
  type VerificationFreshnessPolicy,
} from "./verification-freshness";
import {
  VerificationAdmission,
  VerificationOptIn,
} from "./verification-budget-admission";
import {
  TwilioVerifyAdapter,
  VerifyAdapterResult,
} from "./twilio-verify.adapter";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Entry = {
  id: string;
  attemptId: string;
  digest: string;
  phoneDigest: string;
  kind: "START" | "CHECK";
  startId: string;
  reservedAt: string;
  result: VerifyAdapterResult | null;
  proof?: VerificationProof | null;
  freshnessPolicy?: VerificationFreshnessPolicy;
};
type Ledger = { version: 1; entries: Entry[] };
const unavailable = () =>
  new ServiceUnavailableException(
    "Verification outcome is unconfirmed. Do not resend automatically.",
  );

/** Durable core with explicit ports; StagingPhoneService is its default-disabled
 * phone-only HTTP composition. Other callers remain local proving connections.
 * One START and up to five CHECK operations per session in this bounded model.
 * Orphan reservations are NEVER reclaimed: a crash may have occurred after a provider call.
 * Opt-in, live budgets, recovery and admission authority are separate activation gates.
 */
export class DurableVerificationService {
  private readonly key: Buffer;
  constructor(
    private readonly prisma: Pick<PrismaService, "$transaction">,
    private readonly cipher: Pick<
      ConversationMemoryCipher,
      "encrypt" | "decrypt"
    >,
    private readonly credentials: CustomerConsentCredentials,
    key: Buffer,
    private readonly adapter?: Pick<TwilioVerifyAdapter, "start" | "check">,
    private readonly admission?: VerificationAdmission,
    private readonly freshnessPolicy?: (
      tx: Prisma.TransactionClient,
      tenantId: string,
    ) => Promise<VerificationFreshnessPolicy | null>,
  ) {
    if (!Buffer.isBuffer(key) || key.length !== 32)
      throw Error("Explicit verification digest key required.");
    this.key = Buffer.from(key);
  }

  async execute(input: Record<string, unknown>, optIn?: VerificationOptIn) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !==
        "code,kind,operationId,phone,sessionToken,startOperationId" ||
      typeof input.kind !== "string" ||
      !["START", "CHECK"].includes(input.kind) ||
      typeof input.operationId !== "string" ||
      !UUID.test(input.operationId) ||
      typeof input.sessionToken !== "string" ||
      input.sessionToken.length > 4096 ||
      typeof input.phone !== "string" ||
      !/^\+[1-9]\d{7,14}$/.test(input.phone) ||
      (input.kind === "START"
        ? input.code !== "" || input.startOperationId !== ""
        : typeof input.code !== "string" ||
          !/^\d{6}$/.test(input.code) ||
          typeof input.startOperationId !== "string" ||
          !UUID.test(input.startOperationId))
    )
      throw new BadRequestException("Invalid durable verification request.");
    if (!this.adapter || !this.admission) throw unavailable();
    optIn = optIn ? { ...optIn } : undefined;
    input = { ...input };
    const token = input.sessionToken as string;
    const session = this.credentials.verifySession(token);
    const kind = input.kind as Entry["kind"];
    const digest = this.hash(
      JSON.stringify([
        session.tenantId,
        session.sessionId,
        kind,
        input.operationId,
        input.phone,
        input.code,
        input.startOperationId,
        ...(optIn ? [optIn.requested, optIn.noticeVersion] : []),
      ]),
    );
    const phoneDigest = this.hash(input.phone as string);
    let reservation: {
      entry: Entry;
      fresh: boolean;
      verificationSid?: string;
      policy?: VerificationFreshnessPolicy | null;
    };
    try {
      reservation = await this.prisma.$transaction(async (tx) => {
        await this.admission!.lock(tx, session.tenantId);
        const ledger = await this.read(tx, token);
        const prior = ledger.entries.find((e) => e.id === input.operationId);
        if (prior) {
          if (prior.digest !== digest)
            throw new ConflictException("Verification operation changed.");
          await this.admission!.replay?.(
            tx,
            session,
            prior.kind === "START" ? prior.id : prior.startId,
            phoneDigest,
          );
          return { entry: prior, fresh: false };
        }
        const policy = await this.freshnessPolicy?.(tx, session.tenantId);
        if (this.freshnessPolicy && !validFreshnessPolicy(policy))
          throw new ConflictException(
            "Current verification freshness policy required.",
          );
        if (
          ledger.entries.some(
            (e) =>
              !e.result || ["UNKNOWN", "APPROVED"].includes(e.result.outcome),
          )
        )
          throw new ConflictException(
            "Existing verification requires resolution.",
          );
        let verificationSid: string | undefined;
        if (kind === "START") {
          if (ledger.entries.length)
            throw new ConflictException(
              "This session already requested verification.",
            );
        } else {
          const start = ledger.entries.find(
            (e) => e.kind === "START" && e.id === input.startOperationId,
          );
          if (
            !start ||
            start.proof === null ||
            (this.freshnessPolicy &&
              !sameFreshnessPolicy(start.freshnessPolicy, policy)) ||
            start.phoneDigest !== phoneDigest ||
            start.result?.outcome !== "PENDING" ||
            !start.result.verificationSid ||
            ledger.entries.length >= 6
          )
            throw new ConflictException("Verification check is unavailable.");
          if (
            ledger.entries.some(
              (e) => e.kind === "CHECK" && e.result?.outcome === "EXPIRED",
            )
          )
            throw new ConflictException("Verification expired.");
          verificationSid = start.result.verificationSid;
        }
        const entry: Entry = {
          id: input.operationId as string,
          attemptId: randomUUID(),
          digest,
          phoneDigest,
          kind,
          startId: input.startOperationId as string,
          reservedAt: new Date().toISOString(),
          result: null,
          ...(this.freshnessPolicy && policy
            ? { freshnessPolicy: { ...policy } }
            : {}),
        };
        if (kind === "START") {
          await this.admission!.reserve(
            tx,
            session,
            entry.id,
            phoneDigest,
            optIn,
          );
        } else {
          if (optIn)
            throw new ConflictException("Checks cannot replace consent.");
          await this.admission!.check(tx, session, entry.startId, phoneDigest);
        }
        ledger.entries.push(entry);
        await this.write(tx, session, ledger);
        await tx.auditLog.create({
          data: {
            tenantId: session.tenantId,
            entityType: "Conversation",
            entityId: session.conversationId,
            actorType: "CUSTOMER",
            actorId: "verification-session",
            action: "conversation.verification_reserved",
            metadata: {
              operationId: entry.id,
              attemptId: entry.attemptId,
              kind,
              billing: "UNRECONCILED",
              sdkInvocations: null,
            },
          },
        });
        this.credentials.verifySession(token);
        return {
          entry,
          fresh: true,
          verificationSid,
          policy: policy ? { ...policy } : null,
        };
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw unavailable();
    }
    if (!reservation.fresh) return this.receipt(reservation.entry);
    // Transaction is committed before the injected adapter is invoked.
    let observed: VerifyAdapterResult;
    try {
      const body = {
        tenantId: session.tenantId,
        operationId: input.operationId,
        phone: input.phone,
      };
      observed =
        kind === "START"
          ? await this.adapter.start(body)
          : await this.adapter.check({
              ...body,
              verificationSid: reservation.verificationSid,
              code: input.code,
            });
      if (!validResult(observed, reservation.entry)) throw Error("invalid");
      if (
        kind === "CHECK" &&
        observed.verificationSid &&
        observed.verificationSid !== reservation.verificationSid
      )
        throw Error("invalid binding");
      observed = { ...observed, usage: { ...observed.usage } };
    } catch {
      observed = {
        operationId: input.operationId as string,
        outcome: "UNKNOWN",
        usage: { operation: kind, sdkInvocations: 1, billing: "UNRECONCILED" },
        phoneAccessAuthorized: false,
        bookingAuthorized: false,
        deliveryAuthorized: false,
      };
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const ledger = await this.read(tx, token);
        const entry = ledger.entries.find((e) => e.id === input.operationId);
        if (
          !entry ||
          entry.digest !== digest ||
          entry.attemptId !== reservation.entry.attemptId ||
          entry.result
        )
          throw new ConflictException();
        entry.result = observed;
        if (observed.outcome === "APPROVED" && this.freshnessPolicy) {
          const policy = await this.freshnessPolicy(tx, session.tenantId);
          const now = await this.clock(tx);
          entry.proof =
            entry.proof !== null &&
            sameFreshnessPolicy(reservation.policy, policy)
              ? createVerificationProof(
                  {
                    tenantId: session.tenantId,
                    sessionId: session.sessionId,
                    revision: phoneDigest,
                    expiresAt: session.expiresAt,
                  },
                  policy,
                  now,
                  now,
                )
              : null;
        }
        await this.write(tx, session, ledger);
        await tx.auditLog.create({
          data: {
            tenantId: session.tenantId,
            entityType: "Conversation",
            entityId: session.conversationId,
            actorType: "CUSTOMER",
            actorId: "verification-session",
            action: "conversation.verification_observed",
            metadata: {
              operationId: entry.id,
              attemptId: entry.attemptId,
              kind,
              outcome: observed.outcome,
              sdkInvocations: observed.usage.sdkInvocations,
              billing: observed.usage.billing,
            },
          },
        });
        this.credentials.verifySession(token);
        return this.receipt(entry);
      });
    } catch {
      // Preserve potential cost and no-replay reservation even if result/audit persistence fails.
      return this.receipt(reservation.entry);
    }
  }

  private receipt(entry: Entry) {
    return {
      operationId: entry.id,
      attemptId: entry.attemptId,
      state: entry.result ? "OBSERVED" : "UNCONFIRMED",
      outcome: entry.result?.outcome ?? "UNKNOWN",
      usage: {
        kind: entry.kind,
        sdkInvocations: entry.result?.usage.sdkInvocations ?? null,
        billing: entry.result?.usage.billing ?? "UNRECONCILED",
      },
      phoneAccessAuthorized: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    };
  }

  /** Read/revoke under the same session lock as observation. No provider or budget mutation.
   * Old successful receipts without proof metadata never acquire fresh authority on replay.
   */
  async freshness(input: {
    sessionToken: string;
    phone: string;
    revoke: boolean;
  }) {
    input = { ...input };
    if (
      Object.keys(input).sort().join(",") !== "phone,revoke,sessionToken" ||
      typeof input.sessionToken !== "string" ||
      typeof input.phone !== "string" ||
      !/^\+[1-9]\d{7,14}$/.test(input.phone) ||
      typeof input.revoke !== "boolean"
    )
      throw new BadRequestException();
    const session = this.credentials.verifySession(input.sessionToken);
    return this.prisma.$transaction(async (tx) => {
      const ledger = await this.read(tx, input.sessionToken);
      const revision = this.hash(input.phone);
      const entry = ledger.entries.find(
        (e) =>
          e.kind === "CHECK" &&
          e.phoneDigest === revision &&
          e.result?.outcome === "APPROVED",
      );
      const policy = await this.freshnessPolicy?.(tx, session.tenantId);
      const now = await this.clock(tx);
      const current =
        !input.revoke &&
        verificationProofCurrent(
          entry?.proof,
          {
            tenantId: session.tenantId,
            sessionId: session.sessionId,
            revision,
            expiresAt: session.expiresAt,
          },
          policy,
          now,
        );
      // Invalidation is sticky; changing back cannot resurrect a previously invalid proof.
      const revoke = input.revoke
        ? ledger.entries.filter(
            (e) => e.phoneDigest === revision && e.proof !== null,
          )
        : entry?.proof && !current
          ? [entry]
          : [];
      if (revoke.length) {
        for (const e of revoke) e.proof = null;
        await this.write(tx, session, ledger);
        await tx.auditLog.create({
          data: {
            tenantId: session.tenantId,
            entityType: "Conversation",
            entityId: session.conversationId,
            actorType: "CUSTOMER",
            actorId: "verification-session",
            action: "conversation.verification_proof_revoked",
            metadata: { operationId: revoke[0].id },
          },
        });
      }
      this.credentials.verifySession(input.sessionToken);
      return {
        state: current ? ("CURRENT" as const) : ("NOT_CURRENT" as const),
        checkedAt: current ? entry!.proof!.checkedAt : null,
        expiresAt: current ? entry!.proof!.expiresAt : null,
      };
    });
  }
  private async clock(tx: Prisma.TransactionClient) {
    const [row] = await tx.$queryRaw<{ ms: bigint }[]>(
      Prisma.sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms`,
    );
    const now = Number(row?.ms);
    if (!Number.isSafeInteger(now)) throw unavailable();
    return now;
  }
  private async read(
    tx: Prisma.TransactionClient,
    token: string,
  ): Promise<Ledger> {
    const session = this.credentials.verifySession(token);
    if ((await lockCustomerConsentSession(tx, session)).status !== "ONGOING")
      throw new ConflictException();
    const rows = await tx.$queryRaw<{ value: unknown }[]>(
      Prisma.sql`SELECT "collectedData" -> 'verificationOperations' AS value FROM "Conversation" WHERE id=${session.conversationId}::uuid AND "tenantId"=${session.tenantId}::uuid`,
    );
    if (rows.length !== 1) throw new ConflictException();
    if (rows[0].value === null) return { version: 1, entries: [] };
    if (typeof rows[0].value !== "string") throw new ConflictException();
    const raw = this.cipher.decrypt(rows[0].value);
    if (!raw) throw new ConflictException();
    const value = JSON.parse(raw) as Ledger;
    if (
      !value ||
      Object.keys(value).sort().join(",") !== "entries,version" ||
      value.version !== 1 ||
      !Array.isArray(value.entries) ||
      value.entries.length > 6 ||
      !value.entries.every(
        (e) =>
          e &&
          Object.keys(e)
            .filter((key) => key !== "proof" && key !== "freshnessPolicy")
            .sort()
            .join(",") ===
            "attemptId,digest,id,kind,phoneDigest,reservedAt,result,startId" &&
          (e.freshnessPolicy === undefined ||
            validFreshnessPolicy(e.freshnessPolicy)) &&
          UUID.test(e.id) &&
          UUID.test(e.attemptId) &&
          /^[a-f0-9]{64}$/.test(e.digest) &&
          /^[a-f0-9]{64}$/.test(e.phoneDigest) &&
          ["START", "CHECK"].includes(e.kind) &&
          typeof e.reservedAt === "string" &&
          Number.isFinite(Date.parse(e.reservedAt)) &&
          (e.kind === "START" ? e.startId === "" : UUID.test(e.startId)) &&
          (e.result === null || validResult(e.result, e)),
      ) ||
      new Set(value.entries.map((e) => e.id)).size !== value.entries.length
    )
      throw new ConflictException();
    return value;
  }
  private async write(
    tx: Prisma.TransactionClient,
    scope: { tenantId: string; conversationId: string },
    ledger: Ledger,
  ) {
    const encrypted = this.cipher.encrypt(JSON.stringify(ledger));
    const count = await tx.$executeRaw(
      Prisma.sql`UPDATE "Conversation" SET "collectedData"=jsonb_set("collectedData",'{verificationOperations}',${JSON.stringify(encrypted)}::jsonb),"updatedAt"=clock_timestamp() WHERE id=${scope.conversationId}::uuid AND "tenantId"=${scope.tenantId}::uuid`,
    );
    if (count !== 1) throw new ConflictException();
  }
  private hash(value: string) {
    return createHmac("sha256", this.key).update(value).digest("hex");
  }
}
function validResult(value: VerifyAdapterResult, entry: Entry) {
  return (
    value &&
    typeof value === "object" &&
    Object.keys(value).sort().join(",") ===
      (value.verificationSid
        ? "bookingAuthorized,deliveryAuthorized,operationId,outcome,phoneAccessAuthorized,usage,verificationSid"
        : "bookingAuthorized,deliveryAuthorized,operationId,outcome,phoneAccessAuthorized,usage") &&
    value.operationId === entry.id &&
    [
      "PENDING",
      "APPROVED",
      "EXPIRED",
      "REFUSED",
      "RATE_LIMITED",
      "UNKNOWN",
      "UNAVAILABLE",
    ].includes(value.outcome) &&
    (value.verificationSid === undefined ||
      /^VE[0-9a-fA-F]{32}$/.test(value.verificationSid)) &&
    (!["PENDING", "APPROVED"].includes(value.outcome) ||
      !!value.verificationSid) &&
    (entry.kind === "CHECK" || value.outcome !== "APPROVED") &&
    value.usage &&
    Object.keys(value.usage).sort().join(",") ===
      "billing,operation,sdkInvocations" &&
    value.usage.operation === entry.kind &&
    [0, 1].includes(value.usage.sdkInvocations) &&
    (!["APPROVED", "PENDING"].includes(value.outcome) ||
      value.usage.sdkInvocations === 1) &&
    value.usage.billing ===
      (value.usage.sdkInvocations === 0 ? "NOT_ATTEMPTED" : "UNRECONCILED") &&
    value.phoneAccessAuthorized === false &&
    value.bookingAuthorized === false &&
    value.deliveryAuthorized === false
  );
}
