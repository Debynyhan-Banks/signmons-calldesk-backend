import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { getRequestContext } from "../common/context/request-context";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { lockCustomerConsentSession } from "./customer-consent-session-lock";
import { fixtureSmsInput, fixtureSmsBinding } from "./fixture-sms-policy";
import { lifecycle, sessionCleanupDue } from "./verification-retention";
import {
  lockSmsConsentRecipient,
  smsConsentPhoneHash,
} from "./sms-consent-recipient";
import { TenantSmsPolicyRegistry } from "./tenant-sms-policy-registry";

const flags = {
  mode: "DRY_RUN",
  fixtureOnly: true,
  liveCaptureEnabled: false,
  liveConsentRecorded: false,
  deliveryAuthorized: false,
} as const;
const unavailable = () =>
  new ConflictException("SMS capture source changed or is unavailable.");

/** Inactive application seam. No controller/DI binding or live-mode switch.
 * Reuses credential/session, encryption, registry and recipient-lock contracts.
 * These records cannot update legacy consent or authorize a provider/queue.
 */
export class PolicyBoundSmsCapture {
  constructor(
    private readonly prisma: Pick<PrismaService, "$transaction">,
    private readonly cipher: Pick<
      ConversationMemoryCipher,
      "encrypt" | "decrypt"
    >,
    private readonly credentials: CustomerConsentCredentials,
    private readonly registry: Pick<TenantSmsPolicyRegistry, "readForCapture">,
    private readonly hashing: { key: string; version: string },
  ) {}

  async handle(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Reuse the existing exact five-field DTO; no caller-supplied policy or authority.
    const input = fixtureSmsInput(raw);
    if (
      (input.action === "PROMPT" &&
        (input.promptId !== "" || input.accepted)) ||
      (input.action === "CAPTURE" &&
        !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.promptId))
    )
      throw new BadRequestException("Invalid SMS capture request.");
    const claims = this.credentials.verifySession(input.sessionToken);
    const ctx = getRequestContext();
    if (
      ctx?.tenantId !== claims.tenantId ||
      !ctx.userId ||
      ctx.impersonatedTenantId ||
      !["owner", "admin", "webchat_integration"].includes(
        ctx.role?.toLowerCase() ?? "",
      )
    )
      throw new ForbiddenException("SMS capture access denied.");
    if (
      typeof this.hashing.version !== "string" ||
      !/^[A-Za-z0-9._:-]{1,64}$/.test(this.hashing.version)
    )
      throw new ServiceUnavailableException(
        "SMS hash key version is unavailable.",
      );
    const phoneHash = smsConsentPhoneHash(
      this.hashing.key,
      claims.tenantId,
      input.phone,
    );
    const scope = {
      tenantId: claims.tenantId,
      conversationId: claims.conversationId,
      sessionId: claims.sessionId,
    };
    const binding = fixtureSmsBinding(claims);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await lockSmsConsentRecipient(tx, scope.tenantId, phoneHash);
          const locked = await lockCustomerConsentSession(tx, claims);
          const state = lifecycle(locked.lifecycle);
          if (locked.status !== "ONGOING" || !locked.hasLifecycle || !state)
            throw unavailable();
          const consent = await tx.smsConsentRecord.findUnique({
            where: {
              tenantId_phoneHash: { tenantId: scope.tenantId, phoneHash },
            },
            select: { id: true, status: true, revision: true },
          });
          if (consent?.status === "OPTED_OUT") throw unavailable();
          const customer = (
            await tx.conversation.findUnique({
              where: {
                id_tenantId: {
                  id: scope.conversationId,
                  tenantId: scope.tenantId,
                },
              },
              select: {
                customer: {
                  select: { id: true, phone: true, updatedAt: true },
                },
              },
            })
          )?.customer;
          if (!customer || customer.phone !== input.phone) throw unavailable();
          const policy = await this.registry.readForCapture(tx, scope.tenantId);
          if (
            policy.fixtureOnly !== true ||
            policy.liveCaptureEnabled !== false ||
            policy.deliveryAuthorized !== false
          )
            throw unavailable();
          const now = await this.now(tx);
          const deadline = Math.min(
            claims.expiresAt,
            state.expiresAt,
            Date.parse(policy.expiresAt),
          );
          this.credentials.verifySession(input.sessionToken);
          if (
            now < claims.issuedAt ||
            now >= deadline ||
            sessionCleanupDue(state, now)
          )
            throw unavailable();
          const source = {
            binding,
            policy,
            phoneHash,
            hashKeyVersion: this.hashing.version,
            consent,
            customerId: customer.id,
            customerUpdatedAt: customer.updatedAt.toISOString(),
          };
          if (input.action === "PROMPT") {
            if ((await tx.smsPolicyCapture.count({ where: scope })) >= 256)
              throw new ServiceUnavailableException(
                "SMS prompt capacity reached.",
              );
            const id = randomUUID(),
              expiresAt = Math.min(now + 300000, deadline);
            await tx.smsPolicyCapture.create({
              data: {
                ...scope,
                id,
                policyVersionId: policy.versionId,
                policyRevision: policy.revision,
                phoneHash,
                hashKeyVersion: this.hashing.version,
                consentRevision: consent?.revision ?? 0,
                mode: "DRY_RUN",
                issuedAt: new Date(now),
                expiresAt: new Date(expiresAt),
                encryptedSnapshot: this.cipher.encrypt(
                  JSON.stringify({ id, source, issuedAt: now, expiresAt }),
                ),
              },
            });
            return {
              ...flags,
              state: "PROMPT",
              promptId: id,
              expiresAt,
              sender: policy.legalSender,
              disclosure: policy.disclosure,
              disclosureVersion: policy.disclosureVersion,
              policyVersion: policy.versionId,
              privacyUrl: policy.privacyUrl,
              privacyVersion: policy.privacyVersion,
              termsUrl: policy.termsUrl,
              termsVersion: policy.termsVersion,
              purpose: policy.purpose,
            };
          }
          const prompt = await tx.smsPolicyCapture.findFirst({
            where: { ...scope, id: input.promptId },
          });
          if (
            !prompt ||
            prompt.mode !== "DRY_RUN" ||
            prompt.expiresAt.getTime() <= now ||
            prompt.policyVersionId !== policy.versionId ||
            prompt.policyRevision !== policy.revision ||
            prompt.phoneHash !== phoneHash ||
            prompt.hashKeyVersion !== this.hashing.version ||
            prompt.consentRevision !== (consent?.revision ?? 0)
          )
            throw unavailable();
          const expected = JSON.stringify({
            id: prompt.id,
            source,
            issuedAt: prompt.issuedAt.getTime(),
            expiresAt: prompt.expiresAt.getTime(),
          });
          if (this.cipher.decrypt(prompt.encryptedSnapshot) !== expected)
            throw unavailable();
          if (!input.accepted) return { ...flags, state: "NOT_RECORDED" };
          if (!prompt.recordedAt) {
            const audit = await tx.auditLog.create({
              data: {
                tenantId: scope.tenantId,
                actorType: "SYSTEM_AI",
                actorId: "policy-capture-dry-run",
                entityType: "SmsPolicyCapture",
                entityId: prompt.id,
                action: "sms.policy_capture_dry_run",
                metadata: {
                  ...flags,
                  policyVersionId: policy.versionId,
                  policyRevision: policy.revision,
                },
              },
            });
            await tx.smsPolicyCapture.update({
              where: { id: prompt.id },
              data: { recordedAt: new Date(now), sourceAuditId: audit.id },
            });
          }
          // Attestation/expiry can change while writes execute. Recheck before committing.
          await this.registry.readForCapture(tx, scope.tenantId, {
            versionId: policy.versionId,
            revision: policy.revision,
          });
          const finalNow = await this.now(tx);
          this.credentials.verifySession(input.sessionToken);
          if (
            finalNow < now ||
            finalNow >= prompt.expiresAt.getTime() ||
            finalNow >= deadline ||
            sessionCleanupDue(state, finalNow)
          )
            throw unavailable();
          return {
            ...flags,
            state: "RECORDED",
            promptId: prompt.id,
            recordedAt: prompt.recordedAt?.getTime() ?? now,
            expiresAt: prompt.expiresAt.getTime(),
            policyVersion: policy.versionId,
          };
        },
        { maxWait: 2000, timeout: 5000 },
      );
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500)
        throw error;
      throw new ServiceUnavailableException(
        "SMS capture outcome unconfirmed. Retry the same unexpired request.",
      );
    }
  }

  private async now(tx: Prisma.TransactionClient): Promise<number> {
    const [clock] = await tx.$queryRaw<{ nowMs: bigint }[]>(
      Prisma.sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs"`,
    );
    const now = Number(clock?.nowMs);
    if (!Number.isSafeInteger(now)) throw unavailable();
    return now;
  }
}
