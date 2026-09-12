import {
  BadRequestException,
  ServiceUnavailableException,
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
import type { PrismaService } from "../prisma/prisma.service";
import { SmsConsentService } from "./sms-consent.service";

describe("SmsConsentService", () => {
  const tenantId = "8cf1e75e-14e7-4d4f-afd1-b4416a832ba1";
  const phoneNumber = "+12165550183";
  const transaction = {
    $queryRaw: jest.fn(),
    smsConsentRecord: { upsert: jest.fn(), findUnique: jest.fn() },
    customer: { updateMany: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    smsConsentRecord: { findUnique: jest.fn() },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const identity: TwilioTenantIdentityConfig = {
    tenantId,
    phoneNumber: "+13305550123",
    environment: "staging",
    enabled: true,
    displayName: "Example Contractor",
    voiceGreeting: "Thank you for calling Example Contractor.",
    timeZone: "America/New_York",
    outboundQuietHoursStart: 21,
    outboundQuietHoursEnd: 8,
    supportPhone: "+12165550199",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    transaction.smsConsentRecord.findUnique.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(
      async (callback: (value: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    );
  });

  it("persists verbal consent and a privacy-safe audit", async () => {
    const service = createService();
    const evidenceAt = new Date("2026-09-07T16:00:00.000Z");

    await service.recordVerbalConsent({
      tenantId,
      phoneNumber,
      accepted: true,
      disclosureVersion: "verbal-service-v1",
      evidenceAt,
      actorId: "assistant-v1",
      actorType: AuditActorType.SYSTEM_AI,
    });

    expect(transaction.smsConsentRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: SmsConsentStatus.OPTED_IN,
          source: SmsConsentSource.VERBAL,
          disclosureVersion: "verbal-service-v1",
        }),
      }),
    );
    expect(transaction.customer.updateMany).toHaveBeenCalledWith({
      where: { tenantId, phone: phoneNumber },
      data: { consentToText: true, consentToTextAt: evidenceAt },
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "sms.consent_granted",
          actorType: AuditActorType.SYSTEM_AI,
        }),
      }),
    );
    const stored = JSON.stringify(
      transaction.smsConsentRecord.upsert.mock.calls[0],
    );
    const audit = JSON.stringify(transaction.auditLog.create.mock.calls[0]);
    expect(stored).not.toContain(phoneNumber);
    expect(audit).not.toContain(phoneNumber);
  });

  it("STOP immediately persists suppression and confirms opt-out", async () => {
    const service = createService();

    const reply = await service.handleInboundKeyword({
      tenantId,
      phoneNumber,
      body: " stop ",
      displayName: identity.displayName,
      supportPhone: identity.supportPhone,
    });

    expect(reply).toContain("opted out");
    expect(transaction.smsConsentRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: SmsConsentStatus.OPTED_OUT,
          source: SmsConsentSource.KEYWORD,
        }),
      }),
    );
    expect(transaction.customer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ consentToText: false }),
      }),
    );
  });

  it("records Twilio Advanced Opt-Out without sending a duplicate reply", async () => {
    const service = createService();

    const reply = await service.handleInboundKeyword({
      tenantId,
      phoneNumber,
      body: "unsubscribe",
      optOutType: "STOP",
      displayName: identity.displayName,
      supportPhone: identity.supportPhone,
    });

    expect(reply).toBeNull();
    expect(transaction.smsConsentRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: SmsConsentStatus.OPTED_OUT }),
      }),
    );
  });

  it("START restores only a previously opted-out recipient", async () => {
    transaction.smsConsentRecord.findUnique.mockResolvedValue({
      status: SmsConsentStatus.OPTED_OUT,
    });
    const service = createService();

    const reply = await service.handleInboundKeyword({
      tenantId,
      phoneNumber,
      body: "START",
      displayName: identity.displayName,
      supportPhone: identity.supportPhone,
    });

    expect(reply).toContain("have resumed");
    expect(transaction.smsConsentRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: SmsConsentStatus.OPTED_IN }),
      }),
    );
  });

  it("rejects START when prior opt-out evidence is absent", async () => {
    prisma.smsConsentRecord.findUnique.mockResolvedValue(null);
    const service = createService();

    const reply = await service.handleInboundKeyword({
      tenantId,
      phoneNumber,
      body: "START",
      displayName: identity.displayName,
      supportPhone: identity.supportPhone,
    });

    expect(reply).toContain("no prior opt-out");
    expect(transaction.smsConsentRecord.upsert).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "sms.start_rejected" }),
      }),
    );
  });

  it("returns HELP without changing consent", async () => {
    const service = createService();

    const reply = await service.handleInboundKeyword({
      tenantId,
      phoneNumber,
      body: "HELP",
      displayName: identity.displayName,
      supportPhone: identity.supportPhone,
    });

    expect(reply).toContain(identity.supportPhone);
    expect(transaction.smsConsentRecord.upsert).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "sms.help_requested" }),
      }),
    );
  });

  it("locks before reading and writing the recipient", async () => {
    await createService().handleInboundKeyword({
      tenantId,
      phoneNumber,
      body: "STOP",
      displayName: "Fixture",
      supportPhone: phoneNumber,
    });
    expect(transaction.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.smsConsentRecord.findUnique.mock.invocationCallOrder[0],
    );
    expect(
      transaction.smsConsentRecord.findUnique.mock.invocationCallOrder[0],
    ).toBeLessThan(
      transaction.smsConsentRecord.upsert.mock.invocationCallOrder[0],
    );
    expect(JSON.stringify(transaction.$queryRaw.mock.calls)).not.toContain(
      phoneNumber,
    );
  });

  it("refuses a verbal grant after suppression without writing", async () => {
    transaction.smsConsentRecord.findUnique.mockResolvedValue({
      status: SmsConsentStatus.OPTED_OUT,
    });
    await expect(
      createService().recordVerbalConsent({
        tenantId,
        phoneNumber,
        accepted: true,
        disclosureVersion: "v1",
        evidenceAt: new Date(),
        actorId: "fixture",
        actorType: AuditActorType.USER,
      }),
    ).rejects.toThrow("opt-out cannot be replaced");
    expect(transaction.smsConsentRecord.upsert).not.toHaveBeenCalled();
    expect(transaction.customer.updateMany).not.toHaveBeenCalled();
  });

  it("ignores ordinary inbound content in the consent layer", async () => {
    const service = createService();

    await expect(
      service.handleInboundKeyword({
        tenantId,
        phoneNumber,
        body: "My furnace stopped working",
        displayName: identity.displayName,
        supportPhone: identity.supportPhone,
      }),
    ).resolves.toBeNull();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    [null, "no_consent"],
    [{ status: SmsConsentStatus.OPTED_OUT }, "opted_out"],
  ])("suppresses outbound SMS when consent is %p", async (record, reason) => {
    prisma.smsConsentRecord.findUnique.mockResolvedValue(record);
    const service = createService();

    await expect(
      service.evaluateOutbound(
        tenantId,
        phoneNumber,
        identity,
        new Date("2026-09-07T16:00:00.000Z"),
      ),
    ).resolves.toEqual({ allowed: false, reason });
  });

  it("suppresses an opted-in recipient during local quiet hours", async () => {
    prisma.smsConsentRecord.findUnique.mockResolvedValue({
      status: SmsConsentStatus.OPTED_IN,
    });
    const service = createService();

    await expect(
      service.evaluateOutbound(
        tenantId,
        phoneNumber,
        identity,
        new Date("2026-09-08T03:00:00.000Z"),
      ),
    ).resolves.toEqual({ allowed: false, reason: "quiet_hours" });
  });

  it("allows an opted-in recipient outside local quiet hours", async () => {
    prisma.smsConsentRecord.findUnique.mockResolvedValue({
      status: SmsConsentStatus.OPTED_IN,
    });
    const service = createService();

    await expect(
      service.evaluateOutbound(
        tenantId,
        phoneNumber,
        identity,
        new Date("2026-09-07T16:00:00.000Z"),
      ),
    ).resolves.toEqual({ allowed: true });
  });

  it("treats equal outbound bounds as no suppression without changing inbound availability", async () => {
    prisma.smsConsentRecord.findUnique.mockResolvedValue({
      status: SmsConsentStatus.OPTED_IN,
    });
    const service = createService();

    await expect(
      service.evaluateOutbound(
        tenantId,
        phoneNumber,
        {
          ...identity,
          outboundQuietHoursStart: 0,
          outboundQuietHoursEnd: 0,
        },
        new Date("2026-09-08T03:00:00.000Z"),
      ),
    ).resolves.toEqual({ allowed: true });
  });

  it("fails closed before lookup when the consent hash key is missing", async () => {
    const service = createService({ smsConsentHashKey: "" });

    await expect(
      service.evaluateOutbound(tenantId, phoneNumber, identity),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.smsConsentRecord.findUnique).not.toHaveBeenCalled();
  });

  it("rejects malformed inbound sender numbers before persistence", async () => {
    const service = createService();

    await expect(
      service.handleInboundKeyword({
        tenantId,
        phoneNumber: "216-555-0183",
        body: "STOP",
        displayName: identity.displayName,
        supportPhone: identity.supportPhone,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(transaction.smsConsentRecord.upsert).not.toHaveBeenCalled();
  });

  it("rejects outbound evaluation with another tenant's identity", async () => {
    const service = createService();

    await expect(
      service.evaluateOutbound(tenantId, phoneNumber, {
        ...identity,
        tenantId: "9a4ee1b2-807c-4caa-a176-4a5dd0a8eb10",
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.smsConsentRecord.findUnique).not.toHaveBeenCalled();
  });

  function createService(
    overrides: Partial<ConfigType<typeof appConfig>> = {},
  ): SmsConsentService {
    return new SmsConsentService(
      prisma as unknown as PrismaService,
      {
        smsConsentHashKey: "x".repeat(32),
        ...overrides,
      } as ConfigType<typeof appConfig>,
    );
  }
});
