import { createHmac } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import {
  CommunicationChannel,
  CommunicationDirection,
  CommunicationProvider,
  CommunicationStatus,
  RedactionLevel,
} from "@prisma/client";
import appConfig from "../config/app.config";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { PrismaService } from "../prisma/prisma.service";
import { SmsConsentService } from "./sms-consent.service";
import {
  SMS_PROVIDER,
  SmsProviderError,
  type SmsProvider,
} from "./sms-provider.interface";
import {
  evaluateTransactionalMessageState,
  parseTransactionalMessageTemplateKey,
  transactionalMessageJobSelect,
  transactionalMessageStateHash,
} from "./transactional-message-state";

const MAX_ATTEMPTS = 3;

@Injectable()
export class SmsDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: SmsConsentService,
    private readonly cipher: ConversationMemoryCipher,
    @Inject(SMS_PROVIDER) private readonly provider: SmsProvider,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  async create(input: {
    tenantId: string;
    to: string;
    body: string;
    idempotencyKey: string;
    jobId?: string;
    templateId?: string;
    templateKey?: string;
    templateVersion?: number;
    lifecycleStateHash?: string;
  }): Promise<{ id: string; status: CommunicationStatus }> {
    if (
      !input.body.trim() ||
      input.body.length > 1600 ||
      !input.idempotencyKey.trim()
    ) {
      throw new BadRequestException("SMS request is invalid.");
    }
    const identity = this.identity(input.tenantId);
    const decision = await this.consent.evaluateOutbound(
      input.tenantId,
      input.to,
      identity,
    );
    if (!decision.allowed)
      throw new ConflictException(`SMS suppressed: ${decision.reason}.`);
    const keyHash = this.hash(input.tenantId, input.idempotencyKey);
    const requestHash = this.hash(
      input.tenantId,
      JSON.stringify({
        to: input.to,
        body: input.body,
        jobId: input.jobId,
        templateId: input.templateId,
        templateKey: input.templateKey,
        templateVersion: input.templateVersion,
        lifecycleStateHash: input.lifecycleStateHash,
      }),
    );
    const event = await this.prisma.communicationEvent.upsert({
      where: {
        tenantId_idempotencyKeyHash: {
          tenantId: input.tenantId,
          idempotencyKeyHash: keyHash,
        },
      },
      create: {
        tenantId: input.tenantId,
        jobId: input.jobId,
        jobTenantId: input.jobId ? input.tenantId : undefined,
        channel: CommunicationChannel.SMS,
        direction: CommunicationDirection.OUTBOUND,
        provider: CommunicationProvider.TWILIO,
        idempotencyKeyHash: keyHash,
        status: CommunicationStatus.QUEUED,
        redactionLevel: RedactionLevel.FULL,
        content: {
          create: {
            tenantId: input.tenantId,
            templateId: input.templateId,
            payload: {
              kind: "transactional_sms",
              recipientHash: this.hash(input.tenantId, input.to),
              requestHash,
              ...(input.templateKey ? { templateKey: input.templateKey } : {}),
              ...(input.templateVersion
                ? { templateVersion: input.templateVersion }
                : {}),
              ...(input.lifecycleStateHash
                ? { lifecycleStateHash: input.lifecycleStateHash }
                : {}),
            },
            encryptedRaw: this.cipher.encrypt(
              JSON.stringify({ to: input.to, body: input.body }),
            ),
          },
        },
      },
      update: {},
      select: {
        id: true,
        status: true,
        content: { select: { payload: true } },
      },
    });
    const payload = event.content?.payload;
    if (
      !payload ||
      typeof payload !== "object" ||
      !("requestHash" in payload) ||
      payload.requestHash !== requestHash
    ) {
      throw new ConflictException(
        "Idempotency key was already used for a different SMS request.",
      );
    }
    return { id: event.id, status: event.status };
  }

  async listHistory(input: {
    tenantId: string;
    jobId?: string;
    limit: number;
  }) {
    const events = await this.prisma.communicationEvent.findMany({
      where: {
        tenantId: input.tenantId,
        channel: CommunicationChannel.SMS,
        ...(input.jobId ? { jobId: input.jobId } : {}),
      },
      orderBy: { occurredAt: "desc" },
      take: input.limit,
      select: {
        id: true,
        jobId: true,
        direction: true,
        status: true,
        attemptCount: true,
        lastErrorCode: true,
        occurredAt: true,
        terminalAt: true,
        content: { select: { templateId: true, payload: true } },
      },
    });

    return events.map((event) => {
      const payload = this.asPayload(event.content?.payload);
      return {
        id: event.id,
        jobId: event.jobId,
        direction: event.direction,
        status: event.status,
        attemptCount: event.attemptCount,
        lastErrorCode: event.lastErrorCode,
        occurredAt: event.occurredAt,
        terminalAt: event.terminalAt,
        templateId: event.content?.templateId ?? null,
        templateKey:
          typeof payload?.templateKey === "string" ? payload.templateKey : null,
        templateVersion:
          typeof payload?.templateVersion === "number"
            ? payload.templateVersion
            : null,
      };
    });
  }

  async processDue(limit = 25): Promise<number> {
    if (!this.config.smsDeliveryEnabled) return 0;
    const due = await this.prisma.communicationEvent.findMany({
      where: {
        channel: CommunicationChannel.SMS,
        direction: CommunicationDirection.OUTBOUND,
        OR: [
          { status: CommunicationStatus.QUEUED },
          {
            status: CommunicationStatus.FAILED,
            nextAttemptAt: { lte: new Date() },
          },
        ],
        attemptCount: { lt: MAX_ATTEMPTS },
      },
      orderBy: { nextAttemptAt: "asc" },
      take: Math.min(Math.max(limit, 1), 100),
      select: { id: true, tenantId: true },
    });
    await Promise.allSettled(
      due.map((event) => this.deliver(event.tenantId, event.id)),
    );
    return due.length;
  }

  async listDeadLetters(tenantId: string) {
    return this.prisma.communicationEvent.findMany({
      where: {
        tenantId,
        channel: CommunicationChannel.SMS,
        direction: CommunicationDirection.OUTBOUND,
        status: CommunicationStatus.DEAD_LETTER,
      },
      orderBy: { terminalAt: "desc" },
      take: 100,
      select: {
        id: true,
        status: true,
        attemptCount: true,
        lastErrorCode: true,
        occurredAt: true,
        terminalAt: true,
      },
    });
  }

  async metrics(tenantId: string, days: number) {
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      throw new BadRequestException("Metrics range must be 1 to 90 days.");
    }
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const events = await this.prisma.communicationEvent.findMany({
      where: {
        tenantId,
        channel: CommunicationChannel.SMS,
        direction: CommunicationDirection.OUTBOUND,
        occurredAt: { gte: from },
      },
      select: { status: true, attemptCount: true, lastErrorCode: true },
      take: 10_000,
    });
    const byStatus: Record<string, number> = {};
    const failuresByCode: Record<string, number> = {};
    let attempts = 0;
    for (const event of events) {
      byStatus[event.status] = (byStatus[event.status] ?? 0) + 1;
      attempts += event.attemptCount;
      if (event.lastErrorCode) {
        failuresByCode[event.lastErrorCode] =
          (failuresByCode[event.lastErrorCode] ?? 0) + 1;
      }
    }
    return {
      period: { from: from.toISOString(), days },
      total: events.length,
      attempts,
      byStatus,
      failuresByCode,
      truncated: events.length === 10_000,
    };
  }

  async replayDeadLetter(input: {
    tenantId: string;
    eventId: string;
    actorId: string;
    acknowledgeDuplicateRisk: boolean;
    reason: string;
  }): Promise<void> {
    const event = await this.prisma.communicationEvent.findUnique({
      where: { id_tenantId: { id: input.eventId, tenantId: input.tenantId } },
      select: { status: true, lastErrorCode: true },
    });
    if (!event || event.status !== CommunicationStatus.DEAD_LETTER) {
      throw new ConflictException("SMS event is not dead-lettered.");
    }
    if (!input.acknowledgeDuplicateRisk) {
      throw new ConflictException(
        "Replay requires duplicate-risk acknowledgment.",
      );
    }
    if (input.reason.trim().length < 10 || input.reason.length > 500) {
      throw new BadRequestException("Replay reason is invalid.");
    }
    await this.prisma.$transaction([
      this.prisma.communicationEvent.update({
        where: { id_tenantId: { id: input.eventId, tenantId: input.tenantId } },
        data: {
          status: CommunicationStatus.QUEUED,
          attemptCount: 0,
          nextAttemptAt: null,
          terminalAt: null,
          lastErrorCode: null,
          externalId: null,
        },
      }),
      this.prisma.auditLog.create({
        data: {
          tenantId: input.tenantId,
          action: "sms.dead_letter_replayed",
          actorType: "USER",
          actorId: input.actorId,
          entityType: "CommunicationEvent",
          entityId: input.eventId,
          metadata: {
            priorErrorCode: event.lastErrorCode,
            duplicateRiskAcknowledged: true,
            reason: input.reason.trim(),
          },
        },
      }),
    ]);
  }

  async deliver(
    tenantId: string,
    eventId: string,
  ): Promise<CommunicationStatus> {
    const claimed = await this.prisma.communicationEvent.updateMany({
      where: {
        id: eventId,
        tenantId,
        status: {
          in: [CommunicationStatus.QUEUED, CommunicationStatus.FAILED],
        },
        attemptCount: { lt: MAX_ATTEMPTS },
      },
      data: {
        status: CommunicationStatus.SENDING,
        attemptCount: { increment: 1 },
        nextAttemptAt: null,
      },
    });
    if (claimed.count !== 1)
      throw new ConflictException("SMS delivery is not claimable.");
    const event = await this.prisma.communicationEvent.findUniqueOrThrow({
      where: { id_tenantId: { id: eventId, tenantId } },
      include: { content: true },
    });
    const lifecycleError = await this.lifecycleError(event);
    if (lifecycleError) {
      return this.deadLetter(tenantId, eventId, lifecycleError);
    }
    const raw = event.content?.encryptedRaw
      ? this.cipher.decrypt(event.content.encryptedRaw)
      : null;
    if (!raw) return this.deadLetter(tenantId, eventId, "content_unavailable");
    const message = JSON.parse(raw) as { to?: unknown; body?: unknown };
    if (typeof message.to !== "string" || typeof message.body !== "string") {
      return this.deadLetter(tenantId, eventId, "content_invalid");
    }
    const identity = this.identity(tenantId);
    const decision = await this.consent.evaluateOutbound(
      tenantId,
      message.to,
      identity,
    );
    if (!decision.allowed)
      return this.deadLetter(
        tenantId,
        eventId,
        `suppressed_${decision.reason}`,
      );
    try {
      const result = await this.provider.send({
        from: identity.phoneNumber,
        to: message.to,
        body: message.body,
        statusCallback: `${this.config.twilioWebhookBaseUrl}/webhooks/twilio/sms/status`,
      });
      await this.prisma.communicationEvent.update({
        where: { id_tenantId: { id: eventId, tenantId } },
        data: {
          externalId: result.externalId,
          status: CommunicationStatus.SENT,
          lastErrorCode: null,
        },
      });
      return CommunicationStatus.SENT;
    } catch (error) {
      const providerError =
        error instanceof SmsProviderError
          ? error
          : new SmsProviderError("Unknown provider outcome.", "unknown", false);
      const exhausted = event.attemptCount >= MAX_ATTEMPTS;
      if (!providerError.safeToRetry || exhausted)
        return this.deadLetter(tenantId, eventId, providerError.code);
      await this.prisma.communicationEvent.update({
        where: { id_tenantId: { id: eventId, tenantId } },
        data: {
          status: CommunicationStatus.FAILED,
          lastErrorCode: providerError.code,
          nextAttemptAt: new Date(
            Date.now() + 60_000 * 2 ** (event.attemptCount - 1),
          ),
        },
      });
      return CommunicationStatus.FAILED;
    }
  }

  async applyStatus(input: {
    tenantId: string;
    externalId: string;
    providerStatus: string;
    errorCode?: string;
  }): Promise<void> {
    if (!/^(SM|MM)[0-9a-f]{32}$/i.test(input.externalId)) {
      throw new BadRequestException("SMS delivery callback is invalid.");
    }
    const status = mapStatus(input.providerStatus);
    const event = await this.prisma.communicationEvent.findUnique({
      where: {
        tenantId_provider_externalId: {
          tenantId: input.tenantId,
          provider: CommunicationProvider.TWILIO,
          externalId: input.externalId,
        },
      },
      select: { id: true, status: true },
    });
    if (!event) throw new BadRequestException("Unknown SMS delivery callback.");
    if (statusRank(status) <= statusRank(event.status)) return;
    await this.prisma.communicationEvent.update({
      where: { id_tenantId: { id: event.id, tenantId: input.tenantId } },
      data: {
        status,
        lastErrorCode: input.errorCode || null,
        terminalAt:
          status === CommunicationStatus.DELIVERED ||
          status === CommunicationStatus.DEAD_LETTER
            ? new Date()
            : null,
      },
    });
  }

  private async deadLetter(
    tenantId: string,
    id: string,
    code: string,
  ): Promise<CommunicationStatus> {
    await this.prisma.communicationEvent.update({
      where: { id_tenantId: { id, tenantId } },
      data: {
        status: CommunicationStatus.DEAD_LETTER,
        lastErrorCode: code,
        terminalAt: new Date(),
        nextAttemptAt: null,
      },
    });
    return CommunicationStatus.DEAD_LETTER;
  }

  private async lifecycleError(event: {
    tenantId: string;
    jobId: string | null;
    content: { payload: unknown } | null;
  }): Promise<string | null> {
    const payload = this.asPayload(event.content?.payload);
    if (payload?.kind !== "transactional_sms") return null;
    const templateKey = parseTransactionalMessageTemplateKey(
      payload.templateKey,
    );
    const expectedHash = payload.lifecycleStateHash;
    if (
      !event.jobId ||
      !templateKey ||
      typeof expectedHash !== "string" ||
      !/^[0-9a-f]{64}$/i.test(expectedHash)
    ) {
      return "lifecycle_state_unavailable";
    }
    const job = await this.prisma.job.findUnique({
      where: {
        id_tenantId: { id: event.jobId, tenantId: event.tenantId },
      },
      select: transactionalMessageJobSelect,
    });
    return job &&
      evaluateTransactionalMessageState(templateKey, job) === "AVAILABLE" &&
      transactionalMessageStateHash(templateKey, job) === expectedHash
      ? null
      : "stale_lifecycle_state";
  }

  private identity(tenantId: string) {
    const matches = this.config.twilioTenantIdentities.filter(
      (item) =>
        item.enabled &&
        item.tenantId === tenantId &&
        item.environment === this.config.twilioWebhookEnvironment,
    );
    if (matches.length !== 1)
      throw new BadRequestException("Tenant SMS identity is unavailable.");
    return matches[0];
  }

  private asPayload(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private hash(tenantId: string, value: string): string {
    if (!this.config.smsConsentHashKey)
      throw new BadRequestException("SMS hashing is not configured.");
    return createHmac("sha256", this.config.smsConsentHashKey)
      .update(`${tenantId}:${value}`)
      .digest("hex");
  }
}

function mapStatus(value: string): CommunicationStatus {
  if (value === "delivered") return CommunicationStatus.DELIVERED;
  if (value === "failed" || value === "undelivered")
    return CommunicationStatus.DEAD_LETTER;
  if (["accepted", "queued", "sending", "sent"].includes(value))
    return CommunicationStatus.SENT;
  throw new BadRequestException("SMS delivery status is invalid.");
}

function statusRank(status: CommunicationStatus): number {
  if (status === CommunicationStatus.DELIVERED) return 4;
  if (status === CommunicationStatus.DEAD_LETTER) return 3;
  if (status === CommunicationStatus.SENT) return 2;
  return 1;
}
