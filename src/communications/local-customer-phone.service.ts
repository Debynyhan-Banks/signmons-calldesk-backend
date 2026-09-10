import {
  BadRequestException,
  ConflictException,
  HttpException,
} from "@nestjs/common";
import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { lockCustomerConsentSession } from "./customer-consent-session-lock";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const LOCAL_PHONE_POLICY = Object.freeze({
  challengeMs: 300000,
  proofMs: 600000,
  cooldownMs: 30000,
  maxRequests: 3,
  maxAttempts: 5,
  destinationWindowMs: 3600000,
});
type State = {
  version: 1;
  revision: number;
  phone: string;
  challenge: string;
  expires: number;
  verifiedUntil: number;
  nextRequest: number;
  requests: number;
  attempts: number;
  lastId: string;
  lastDigest: string;
};

/** FIXTURE ONLY. No provider, production registration or usable phone-access authority.
 * The fixed code demonstrates application mechanics, never actual phone possession.
 * Numeric policy is local QA policy, not approved production/provider configuration.
 */
export class LocalCustomerPhoneService {
  constructor(
    private readonly prisma: Pick<PrismaService, "$transaction">,
    private readonly cipher: Pick<
      ConversationMemoryCipher,
      "encrypt" | "decrypt"
    >,
    private readonly credentials: CustomerConsentCredentials,
    private readonly fixtureKey: Buffer,
    private readonly clock: () => number = Date.now,
  ) {
    if (!Buffer.isBuffer(fixtureKey) || fixtureKey.length !== 32)
      throw new Error("Explicit 32-byte fixture key required.");
  }

  async handle(input: Record<string, unknown>) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !==
        "action,code,expectedRevision,operationId,phone,sessionToken" ||
      !["request", "check", "clear", "status"].includes(String(input.action)) ||
      typeof input.sessionToken !== "string" ||
      input.sessionToken.length > 4096 ||
      typeof input.operationId !== "string" ||
      !UUID.test(input.operationId) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      Number(input.expectedRevision) < 0 ||
      typeof input.phone !== "string" ||
      (input.phone !== "" && !/^\+[1-9]\d{7,14}$/.test(input.phone)) ||
      typeof input.code !== "string" ||
      (input.action === "check"
        ? !/^\d{6}$/.test(input.code)
        : input.code !== "") ||
      (["request", "check"].includes(String(input.action)) && !input.phone)
    )
      throw new BadRequestException("Invalid local phone request.");
    const token = input.sessionToken;
    const session = this.credentials.verifySession(token);
    const digest = this.hash(
      JSON.stringify([
        input.action,
        input.code,
        input.expectedRevision,
        input.operationId,
        input.phone,
      ]),
    );
    return this.prisma.$transaction(
      async (tx) => {
        const locked = await lockCustomerConsentSession(tx, session);
        if (locked.status !== "ONGOING") throw new ConflictException();
        this.credentials.verifySession(token);
        const now = this.clock();
        if (!Number.isSafeInteger(now) || now < 0)
          throw new ConflictException();
        const rows = await tx.$queryRaw<{ value: unknown }[]>(Prisma.sql`
        SELECT "collectedData" -> 'localPhone' AS value FROM "Conversation"
        WHERE id=${session.conversationId}::uuid AND "tenantId"=${session.tenantId}::uuid`);
        if (rows.length !== 1) throw new ConflictException();
        let state: State = {
          version: 1,
          revision: 0,
          phone: "",
          challenge: "",
          expires: 0,
          verifiedUntil: 0,
          nextRequest: 0,
          requests: 0,
          attempts: 0,
          lastId: "",
          lastDigest: "",
        };
        if (rows[0].value !== null) {
          if (typeof rows[0].value !== "string") throw new ConflictException();
          const raw = this.cipher.decrypt(rows[0].value);
          if (!raw) throw new ConflictException();
          const parsed = JSON.parse(raw) as State;
          if (
            !parsed ||
            Object.keys(parsed).sort().join(",") !==
              "attempts,challenge,expires,lastDigest,lastId,nextRequest,phone,requests,revision,verifiedUntil,version" ||
            parsed.version !== 1 ||
            ![
              "revision",
              "expires",
              "verifiedUntil",
              "nextRequest",
              "requests",
              "attempts",
            ].every(
              (key) =>
                Number.isSafeInteger(parsed[key as keyof State]) &&
                Number(parsed[key as keyof State]) >= 0,
            ) ||
            !["phone", "challenge", "lastId", "lastDigest"].every(
              (key) => typeof parsed[key as keyof State] === "string",
            )
          )
            throw new ConflictException();
          state = parsed;
        }
        const receipt = () => ({
          revision: state.revision,
          state: !state.phone
            ? "EMPTY"
            : state.verifiedUntil > now
              ? "FIXTURE_VERIFIED"
              : state.attempts >= LOCAL_PHONE_POLICY.maxAttempts
                ? "EXHAUSTED"
                : state.expires <= now
                  ? "EXPIRED"
                  : "PENDING",
          expiresAt:
            state.verifiedUntil > now ? state.verifiedUntil : state.expires,
          retryAt: state.nextRequest,
          attemptsRemaining: Math.max(
            0,
            LOCAL_PHONE_POLICY.maxAttempts - state.attempts,
          ),
          fixtureOnly: true,
          phoneAccessAuthorized: false,
          bookingAuthorized: false,
          deliveryAuthorized: false,
        });
        if (input.action === "status") return receipt();
        if (state.lastId === input.operationId) {
          if (state.lastDigest !== digest) throw new ConflictException();
          return receipt();
        }
        if (input.expectedRevision !== state.revision)
          throw new ConflictException();
        if (input.action === "clear") {
          state.phone = state.challenge = "";
          state.verifiedUntil = state.expires = 0;
        } else if (input.action === "request") {
          if (
            state.requests >= LOCAL_PHONE_POLICY.maxRequests ||
            state.attempts >= LOCAL_PHONE_POLICY.maxAttempts ||
            now < state.nextRequest
          )
            throw new HttpException("Local challenge limit reached.", 429);
          const destination = this.hash(
            session.tenantId + ":" + String(input.phone),
          );
          // Cross-session budget, serialized across processes. Session lock precedes destination lock.
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${"local-phone:" + destination}, 0))`,
          );
          const count = await tx.auditLog.count({
            where: {
              tenantId: session.tenantId,
              action: "conversation.local_phone_requested",
              createdAt: {
                gte: new Date(now - LOCAL_PHONE_POLICY.destinationWindowMs),
              },
              metadata: { path: ["destination"], equals: destination },
            },
          });
          if (count >= LOCAL_PHONE_POLICY.maxRequests)
            throw new HttpException("Local challenge limit reached.", 429);
          state.phone = input.phone as string;
          state.challenge = input.operationId as string;
          state.expires = Math.min(
            now + LOCAL_PHONE_POLICY.challengeMs,
            session.expiresAt,
          );
          state.verifiedUntil = 0;
          state.nextRequest = now + LOCAL_PHONE_POLICY.cooldownMs;
          state.requests++;
          await tx.auditLog.create({
            data: {
              tenantId: session.tenantId,
              entityType: "Conversation",
              entityId: session.conversationId,
              actorType: "CUSTOMER",
              actorId: "local-fixture",
              action: "conversation.local_phone_requested",
              metadata: { fixtureOnly: true, destination },
            },
          });
        } else {
          if (
            state.phone !== input.phone ||
            !state.challenge ||
            state.expires <= now ||
            state.attempts >= LOCAL_PHONE_POLICY.maxAttempts ||
            state.verifiedUntil > now
          )
            throw new ConflictException();
          const destination = this.hash(
            session.tenantId + ":" + String(input.phone),
          );
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${"local-phone:" + destination}, 0))`,
          );
          const attempts = await tx.auditLog.count({
            where: {
              tenantId: session.tenantId,
              action: "conversation.local_phone_checked",
              createdAt: {
                gte: new Date(now - LOCAL_PHONE_POLICY.destinationWindowMs),
              },
              metadata: { path: ["destination"], equals: destination },
            },
          });
          if (attempts >= LOCAL_PHONE_POLICY.maxAttempts)
            throw new HttpException("Local challenge limit reached.", 429);
          await tx.auditLog.create({
            data: {
              tenantId: session.tenantId,
              entityType: "Conversation",
              entityId: session.conversationId,
              actorType: "CUSTOMER",
              actorId: "local-fixture",
              action: "conversation.local_phone_checked",
              metadata: { fixtureOnly: true, destination },
            },
          });
          state.attempts++;
          // Deliberately non-secret deterministic adapter; never provider verification.
          if (input.code === "123456")
            state.verifiedUntil = Math.min(
              now + LOCAL_PHONE_POLICY.proofMs,
              session.expiresAt,
            );
        }
        state.revision++;
        state.lastId = input.operationId as string;
        state.lastDigest = digest;
        const encrypted = this.cipher.encrypt(JSON.stringify(state));
        const updated = await tx.$executeRaw(Prisma.sql`UPDATE "Conversation"
        SET "collectedData"=jsonb_set("collectedData",'{localPhone}',${JSON.stringify(encrypted)}::jsonb),
        "updatedAt"=clock_timestamp()
        WHERE id=${session.conversationId}::uuid AND "tenantId"=${session.tenantId}::uuid`);
        if (updated !== 1) throw new ConflictException();
        await tx.auditLog.create({
          data: {
            tenantId: session.tenantId,
            entityType: "Conversation",
            entityId: session.conversationId,
            actorType: "CUSTOMER",
            actorId: "local-fixture",
            action: "conversation.local_phone_changed",
            metadata: {
              fixtureOnly: true,
              revision: state.revision,
              operation: input.action as string,
            },
          },
        });
        this.credentials.verifySession(token);
        return receipt();
      },
      { maxWait: 2000, timeout: 5000 },
    );
  }
  private hash(value: string) {
    return createHmac("sha256", this.fixtureKey).update(value).digest("hex");
  }
}
