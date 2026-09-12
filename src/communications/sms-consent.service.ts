import {
  BadRequestException,
  Inject,
  Injectable,
  ConflictException,
} from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import {
  AuditActorType,
  SmsConsentSource,
  SmsConsentStatus,
} from "@prisma/client";
import appConfig, {
  type TwilioTenantIdentityConfig,
} from "../config/app.config";
import { PrismaService } from "../prisma/prisma.service";
import {
  lockSmsConsentRecipient,
  smsConsentPhoneHash,
} from "./sms-consent-recipient";

const KEYWORD_DISCLOSURE_VERSION = "sms-keyword-v1";

export type OutboundConsentDecision =
  | { allowed: true }
  | { allowed: false; reason: "no_consent" | "opted_out" | "quiet_hours" };

@Injectable()
export class SmsConsentService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  async recordVerbalConsent(input: {
    tenantId: string;
    phoneNumber: string;
    accepted: boolean;
    disclosureVersion: string;
    evidenceAt: Date;
    actorId: string;
    actorType: typeof AuditActorType.USER | typeof AuditActorType.SYSTEM_AI;
  }): Promise<void> {
    if (
      !input.disclosureVersion.trim() ||
      Number.isNaN(input.evidenceAt.getTime())
    ) {
      throw new BadRequestException("Consent evidence is invalid.");
    }
    const status = input.accepted
      ? SmsConsentStatus.OPTED_IN
      : SmsConsentStatus.OPTED_OUT;
    await this.persistConsent({
      tenantId: input.tenantId,
      phoneNumber: input.phoneNumber,
      status,
      source: SmsConsentSource.VERBAL,
      disclosureVersion: input.disclosureVersion,
      evidenceAt: input.evidenceAt,
      actorId: input.actorId,
      actorType: input.actorType,
      action: input.accepted ? "sms.consent_granted" : "sms.consent_declined",
    });
  }

  async handleInboundKeyword(input: {
    tenantId: string;
    phoneNumber: string;
    body: string;
    optOutType?: string;
    displayName: string;
    supportPhone: string;
  }): Promise<string | null> {
    const providerKeyword = input.optOutType?.trim().toUpperCase();
    const providerHandled = ["STOP", "START", "HELP"].includes(
      providerKeyword ?? "",
    );
    const keyword = providerHandled
      ? providerKeyword!
      : input.body.trim().toUpperCase();
    if (keyword === "STOP") {
      await this.persistConsent({
        tenantId: input.tenantId,
        phoneNumber: input.phoneNumber,
        status: SmsConsentStatus.OPTED_OUT,
        source: SmsConsentSource.KEYWORD,
        disclosureVersion: KEYWORD_DISCLOSURE_VERSION,
        evidenceAt: new Date(),
        actorId: "twilio-webhook",
        actorType: AuditActorType.WEBHOOK,
        action: "sms.opted_out",
      });
      return providerHandled
        ? null
        : `${input.displayName}: You have opted out and will receive no further text messages. Reply START to opt in again.`;
    }

    if (keyword === "START") {
      const restored = await this.persistConsent({
        tenantId: input.tenantId,
        phoneNumber: input.phoneNumber,
        status: SmsConsentStatus.OPTED_IN,
        source: SmsConsentSource.KEYWORD,
        disclosureVersion: KEYWORD_DISCLOSURE_VERSION,
        evidenceAt: new Date(),
        actorId: "twilio-webhook",
        actorType: AuditActorType.WEBHOOK,
        action: "sms.opted_in_again",
        requirePriorOptOut: true,
      });
      if (!restored)
        return `${input.displayName}: We could not restore SMS because no prior opt-out was found. Call ${input.supportPhone} to provide consent.`;
      return providerHandled
        ? null
        : `${input.displayName}: SMS service messages have resumed. Message frequency varies. Message and data rates may apply. Reply HELP for help or STOP to opt out.`;
    }

    if (keyword === "HELP") {
      await this.audit(input.tenantId, "sms.help_requested", {});
      return providerHandled
        ? null
        : `${input.displayName}: For help, call ${input.supportPhone}. Reply STOP to opt out.`;
    }

    return null;
  }

  async evaluateOutbound(
    tenantId: string,
    phoneNumber: string,
    identity: TwilioTenantIdentityConfig,
    at: Date = new Date(),
  ): Promise<OutboundConsentDecision> {
    if (identity.tenantId !== tenantId || !identity.enabled) {
      throw new BadRequestException("Communication identity is invalid.");
    }
    const consent = await this.find(tenantId, phoneNumber);
    if (!consent) return { allowed: false, reason: "no_consent" };
    if (consent.status === SmsConsentStatus.OPTED_OUT) {
      return { allowed: false, reason: "opted_out" };
    }
    const hour = localHour(at, identity.timeZone);
    if (
      isQuietHour(
        hour,
        identity.outboundQuietHoursStart,
        identity.outboundQuietHoursEnd,
      )
    ) {
      return { allowed: false, reason: "quiet_hours" };
    }
    return { allowed: true };
  }

  private async find(tenantId: string, phoneNumber: string) {
    return this.prisma.smsConsentRecord.findUnique({
      where: {
        tenantId_phoneHash: {
          tenantId,
          phoneHash: this.phoneHash(tenantId, phoneNumber),
        },
      },
      select: { status: true },
    });
  }

  private async persistConsent(input: {
    tenantId: string;
    phoneNumber: string;
    status: SmsConsentStatus;
    source: SmsConsentSource;
    disclosureVersion: string;
    evidenceAt: Date;
    actorId: string;
    actorType: AuditActorType;
    action: string;
    requirePriorOptOut?: boolean;
  }): Promise<boolean> {
    const phoneHash = this.phoneHash(input.tenantId, input.phoneNumber);
    return this.prisma.$transaction(async (transaction) => {
      await lockSmsConsentRecipient(transaction, input.tenantId, phoneHash);
      const existing = await transaction.smsConsentRecord.findUnique({
        where: { tenantId_phoneHash: { tenantId: input.tenantId, phoneHash } },
        select: { status: true },
      });
      if (
        input.requirePriorOptOut &&
        existing?.status !== SmsConsentStatus.OPTED_OUT
      ) {
        await transaction.auditLog.create({
          data: {
            tenantId: input.tenantId,
            action: "sms.start_rejected",
            actorType: input.actorType,
            actorId: input.actorId,
            entityType: "SmsConsent",
            entityId: phoneHash,
            metadata: { reason: "prior_opt_out_not_found" },
          },
        });
        return false;
      }
      if (
        input.source === SmsConsentSource.VERBAL &&
        input.status === SmsConsentStatus.OPTED_IN &&
        existing?.status === SmsConsentStatus.OPTED_OUT
      ) {
        throw new ConflictException(
          "SMS opt-out cannot be replaced by verbal consent. A new explicit restoration is required.",
        );
      }
      await transaction.smsConsentRecord.upsert({
        where: {
          tenantId_phoneHash: { tenantId: input.tenantId, phoneHash },
        },
        create: {
          tenantId: input.tenantId,
          phoneHash,
          status: input.status,
          source: input.source,
          disclosureVersion: input.disclosureVersion,
          evidenceAt: input.evidenceAt,
        },
        update: {
          status: input.status,
          source: input.source,
          disclosureVersion: input.disclosureVersion,
          evidenceAt: input.evidenceAt,
        },
      });
      await transaction.customer.updateMany({
        where: { tenantId: input.tenantId, phone: input.phoneNumber },
        data: {
          consentToText: input.status === SmsConsentStatus.OPTED_IN,
          consentToTextAt: input.evidenceAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          tenantId: input.tenantId,
          action: input.action,
          actorType: input.actorType,
          actorId: input.actorId,
          entityType: "SmsConsent",
          entityId: phoneHash,
          metadata: {
            status: input.status,
            source: input.source,
            disclosureVersion: input.disclosureVersion,
          },
        },
      });
      return true;
    });
  }

  private async audit(
    tenantId: string,
    action: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        action,
        actorType: AuditActorType.WEBHOOK,
        actorId: "twilio-webhook",
        entityType: "SmsConsent",
        entityId: tenantId,
        metadata,
      },
    });
  }

  private phoneHash(tenantId: string, phoneNumber: string): string {
    return smsConsentPhoneHash(
      this.config.smsConsentHashKey,
      tenantId,
      phoneNumber,
    );
  }
}

function localHour(at: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(at)
    .find((part) => part.type === "hour")?.value;
  return Number(hour ?? "0");
}

function isQuietHour(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}
