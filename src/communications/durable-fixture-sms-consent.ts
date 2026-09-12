import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { lockCustomerConsentSession } from "./customer-consent-session-lock";
import { lifecycle, sessionCleanupDue } from "./verification-retention";
import {
  fixtureSmsInput,
  fixtureSmsPolicy,
  fixtureSmsBinding,
  FIXTURE_SMS_FLAGS,
} from "./fixture-sms-policy";

/** Inactive adapter: fixture evidence only, no production consent or provider dependency.
 * Current policy and recipient are fixture-owned encrypted state, locked throughout
 * capture. No browser-supplied policy, activation endpoint or production DI binding.
 */
export class DurableFixtureSmsConsent {
  constructor(
    private readonly prisma: Pick<PrismaService, "$transaction">,
    private readonly cipher: Pick<
      ConversationMemoryCipher,
      "encrypt" | "decrypt"
    >,
    private readonly credentials: CustomerConsentCredentials,
  ) {}

  async handle(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = fixtureSmsInput(raw);
    if (input.action === "PROMPT" && (input.promptId !== "" || input.accepted))
      throw new BadRequestException("Invalid prompt request.");
    if (
      input.action === "CAPTURE" &&
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.promptId)
    )
      throw new BadRequestException("Invalid prompt reference.");
    const claims = this.credentials.verifySession(input.sessionToken);
    const scope = {
      tenantId: claims.tenantId,
      conversationId: claims.conversationId,
      sessionId: claims.sessionId,
    };
    const envelopeScope = JSON.stringify([
      scope.tenantId,
      scope.conversationId,
      scope.sessionId,
    ]);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const locked = await lockCustomerConsentSession(tx, claims);
          if (locked.status !== "ONGOING" || !locked.hasLifecycle)
            throw new ConflictException("Fixture session is unavailable.");
          const rows = await tx.$queryRaw<
            { encryptedPolicy: string; revision: number }[]
          >(Prisma.sql`
          SELECT "encryptedPolicy", revision FROM "FixtureSmsConsentState"
          WHERE "tenantId"=${scope.tenantId}::uuid AND "conversationId"=${scope.conversationId}::uuid
          AND "sessionId"=${scope.sessionId} FOR UPDATE`);
          if (rows.length !== 1)
            throw new ConflictException("Fixture policy is unavailable.");
          const [clock] = await tx.$queryRaw<{ nowMs: bigint }[]>(Prisma.sql`
          SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs"`);
          const now = Number(clock.nowMs);
          this.credentials.verifySession(input.sessionToken);
          if (
            !Number.isSafeInteger(now) ||
            now < claims.issuedAt ||
            now >= claims.expiresAt
          )
            throw new ConflictException("Fixture session expired.");
          const source = this.decode(rows[0].encryptedPolicy, envelopeScope);
          const policy = fixtureSmsPolicy(source.value, claims, input.phone);
          const currentSession = lifecycle(locked.lifecycle);
          const conversation = await tx.conversation.findUnique({
            where: {
              id_tenantId: {
                id: scope.conversationId,
                tenantId: scope.tenantId,
              },
            },
            select: { customer: { select: { phone: true, updatedAt: true } } },
          });
          if (
            !currentSession ||
            sessionCleanupDue(currentSession, now) ||
            conversation?.customer.phone !== policy.phone
          )
            throw new ConflictException(
              "Fixture recipient or session changed.",
            );
          const binding = fixtureSmsBinding(claims);
          const flags = { ...FIXTURE_SMS_FLAGS, storage: "DURABLE_FIXTURE" };
          if (input.action === "PROMPT") {
            if (policy.optedOut) return { ...flags, state: "UNAVAILABLE" };
            // Bound each session, including expired records; fixture teardown owns deletion.
            if (
              (await tx.fixtureSmsConsentPrompt.count({ where: scope })) >= 256
            )
              throw new ServiceUnavailableException(
                "Fixture prompt capacity reached.",
              );
            const id = randomUUID(),
              expiresAt = Math.min(now + 300000, claims.expiresAt);
            await tx.fixtureSmsConsentPrompt.create({
              data: {
                ...scope,
                id,
                issuedAt: new Date(now),
                expiresAt: new Date(expiresAt),
                encryptedSnapshot: this.cipher.encrypt(
                  JSON.stringify({
                    scope: envelopeScope,
                    value: {
                      id,
                      binding,
                      policy,
                      recipientUpdatedAt:
                        conversation.customer.updatedAt.toISOString(),
                      revision: rows[0].revision,
                      issuedAt: now,
                      expiresAt,
                    },
                  }),
                ),
              },
            });
            return {
              ...flags,
              state: "PROMPT",
              promptId: id,
              expiresAt,
              sender: policy.sender,
              disclosure: policy.disclosure,
              policyVersion: policy.version,
              privacyPath: "/fixture-sms-privacy",
              termsPath: "/fixture-sms-terms",
            };
          }
          const prompt = await tx.fixtureSmsConsentPrompt.findFirst({
            where: { ...scope, id: input.promptId },
          });
          if (!prompt || policy.optedOut || prompt.expiresAt.getTime() <= now)
            throw new ConflictException(
              "Fixture prompt changed or unavailable.",
            );
          const snapshot = this.decode(prompt.encryptedSnapshot, envelopeScope)
            .value as Record<string, unknown>;
          if (
            !snapshot ||
            snapshot.id !== prompt.id ||
            snapshot.revision !== rows[0].revision ||
            snapshot.binding !== binding ||
            snapshot.recipientUpdatedAt !==
              conversation.customer.updatedAt.toISOString() ||
            snapshot.issuedAt !== prompt.issuedAt.getTime() ||
            snapshot.expiresAt !== prompt.expiresAt.getTime() ||
            JSON.stringify(snapshot.policy) !== JSON.stringify(policy)
          )
            throw new ConflictException(
              "Fixture prompt changed or unavailable.",
            );
          if (!input.accepted) return { ...flags, state: "NOT_RECORDED" };
          if (!prompt.recordedAt) {
            const audit = await tx.auditLog.create({
              data: {
                tenantId: scope.tenantId,
                actorType: "SYSTEM_AI",
                actorId: "fixture-customer-session",
                entityType: "FixtureSmsConsentPrompt",
                entityId: prompt.id,
                action: "fixture.sms_consent_captured",
                metadata: {
                  fixtureOnly: true,
                  liveConsentRecorded: false,
                  deliveryAuthorized: false,
                },
              },
            });
            await tx.fixtureSmsConsentPrompt.update({
              where: { id: prompt.id },
              data: { recordedAt: new Date(now), sourceAuditId: audit.id },
            });
          }
          const [finalClock] = await tx.$queryRaw<
            { nowMs: bigint }[]
          >(Prisma.sql`
            SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs"`);
          const finalNow = Number(finalClock.nowMs);
          this.credentials.verifySession(input.sessionToken);
          if (
            !Number.isSafeInteger(finalNow) ||
            finalNow < now ||
            finalNow >= prompt.expiresAt.getTime() ||
            finalNow >= claims.expiresAt ||
            sessionCleanupDue(currentSession, finalNow)
          )
            throw new ConflictException(
              "Fixture prompt expired before completion.",
            );
          return {
            ...flags,
            state: "RECORDED",
            promptId: prompt.id,
            recordedAt: prompt.recordedAt?.getTime() ?? now,
            policyVersion: policy.version,
            expiresAt: prompt.expiresAt.getTime(),
          };
        },
        { maxWait: 2000, timeout: 5000 },
      );
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500)
        throw error;
      throw new ServiceUnavailableException(
        "Fixture consent outcome unconfirmed. Retry the same unexpired request.",
      );
    }
  }

  private decode(
    encrypted: string,
    scope: string,
  ): { scope: string; value: unknown } {
    const plaintext = this.cipher.decrypt(encrypted);
    if (!plaintext || plaintext.length > 16384)
      throw new ConflictException("Fixture evidence unavailable.");
    let value: { scope: string; value: unknown };
    try {
      value = JSON.parse(plaintext) as typeof value;
    } catch {
      throw new ConflictException("Fixture evidence unavailable.");
    }
    if (!value || value.scope !== scope || !value.value)
      throw new ConflictException("Fixture evidence unavailable.");
    return value;
  }
}
