import { ConflictException } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import { CommunicationStatus } from "@prisma/client";
import appConfig from "../config/app.config";
import type { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { SmsConsentService } from "./sms-consent.service";
import { SmsDeliveryService } from "./sms-delivery.service";
import { SmsProviderError, type SmsProvider } from "./sms-provider.interface";
import { TransactionalMessageTemplateKey } from "./transactional-message-template.service";
import { transactionalMessageStateHash } from "./transactional-message-state";

describe("SmsDeliveryService", () => {
  const tenantId = "8cf1e75e-14e7-4d4f-afd1-b4416a832ba1";
  const eventId = "10000000-0000-4000-8000-000000000001";
  const to = "+12165550183";
  const identity = {
    tenantId,
    phoneNumber: "+13305550123",
    environment: "staging" as const,
    enabled: true,
    displayName: "Example Contractor",
    voiceGreeting: "Hello",
    timeZone: "America/New_York",
    outboundQuietHoursStart: 21,
    outboundQuietHoursEnd: 8,
    supportPhone: "+12165550199",
  };
  const prisma = {
    job: { findUnique: jest.fn() },
    communicationEvent: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const consent = { evaluateOutbound: jest.fn() };
  const cipher = { encrypt: jest.fn(), decrypt: jest.fn() };
  const provider = { send: jest.fn() };
  const lifecycleJob = {
    id: "20000000-0000-4000-8000-000000000002",
    status: "ACCEPTED" as const,
    deletedAt: null,
    technicianStatus: "ACCEPTED" as const,
    technicianStatusUpdatedAt: new Date("2026-09-09T13:00:00.000Z"),
    calendarEventId: "calendar-1",
    serviceWindowStart: new Date("2026-09-09T14:00:00.000Z"),
    serviceWindowEnd: new Date("2026-09-09T16:00:00.000Z"),
    calendarOperations: [],
    tenant: { name: "Example Contractor", timezone: "America/New_York" },
    customer: { phone: to },
    assignedUser: {
      id: "30000000-0000-4000-8000-000000000003",
      fullName: "Jordan",
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    consent.evaluateOutbound.mockResolvedValue({ allowed: true });
    cipher.encrypt.mockReturnValue("encrypted");
    cipher.decrypt.mockReturnValue(
      JSON.stringify({ to, body: "Appointment confirmed" }),
    );
    prisma.communicationEvent.findUnique.mockResolvedValue(null);
    prisma.communicationEvent.upsert.mockImplementation(
      (args: { create: { content: { create: { payload: unknown } } } }) =>
        Promise.resolve({
          id: eventId,
          status: CommunicationStatus.QUEUED,
          content: { payload: args.create.content.create.payload },
        }),
    );
    prisma.communicationEvent.updateMany.mockResolvedValue({ count: 1 });
    prisma.communicationEvent.findUniqueOrThrow.mockResolvedValue({
      id: eventId,
      attemptCount: 1,
      content: { encryptedRaw: "encrypted" },
    });
    prisma.communicationEvent.update.mockResolvedValue({});
    prisma.job.findUnique.mockResolvedValue(lifecycleJob);
    provider.send.mockResolvedValue({
      externalId: "SM00000000000000000000000000000001",
      status: "queued",
    });
  });

  it("creates one encrypted, privacy-safe queue record and reuses its idempotency key", async () => {
    const service = createService();
    await service.create({
      tenantId,
      to,
      body: "Appointment confirmed",
      idempotencyKey: "request-1",
    });

    expect(prisma.communicationEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: CommunicationStatus.QUEUED,
          content: {
            create: expect.objectContaining({ encryptedRaw: "encrypted" }),
          },
        }),
      }),
    );
    expect(
      JSON.stringify(prisma.communicationEvent.upsert.mock.calls[0]),
    ).not.toContain(to);

    await expect(
      service.create({
        tenantId,
        to,
        body: "ignored duplicate",
        idempotencyKey: "request-1",
      }),
    ).resolves.toEqual({ id: eventId, status: CommunicationStatus.QUEUED });
    expect(prisma.communicationEvent.upsert).toHaveBeenCalledTimes(2);
  });

  it("rejects an idempotency key reused for different content", async () => {
    prisma.communicationEvent.upsert.mockResolvedValue({
      id: eventId,
      status: CommunicationStatus.QUEUED,
      content: { payload: { requestHash: "different" } },
    });

    await expect(
      createService().create({
        tenantId,
        to,
        body: "Different message",
        idempotencyKey: "request-1",
      }),
    ).rejects.toThrow(ConflictException);
  });

  it("suppresses before queue creation when consent policy denies delivery", async () => {
    consent.evaluateOutbound.mockResolvedValue({
      allowed: false,
      reason: "quiet_hours",
    });
    await expect(
      createService().create({
        tenantId,
        to,
        body: "Hello",
        idempotencyKey: "request-2",
      }),
    ).rejects.toThrow(ConflictException);
    expect(prisma.communicationEvent.upsert).not.toHaveBeenCalled();
  });

  it("claims and sends once with a signed-callback destination", async () => {
    await expect(createService().deliver(tenantId, eventId)).resolves.toBe(
      CommunicationStatus.SENT,
    );
    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: identity.phoneNumber,
        to,
        statusCallback: "https://api.example.test/webhooks/twilio/sms/status",
      }),
    );
    expect(prisma.communicationEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: CommunicationStatus.SENT }),
      }),
    );
  });

  it.each([1, 3])(
    "holds an unsent message at attempt %s without decrypting or contacting a provider",
    async (attemptCount) => {
      prisma.job.findUnique.mockResolvedValue({
        ...lifecycleJob,
        calendarOperations: [{ id: "pending" }],
      });
      prisma.communicationEvent.findUniqueOrThrow.mockResolvedValue({
        id: eventId,
        tenantId,
        jobId: lifecycleJob.id,
        attemptCount,
        content: {
          encryptedRaw: "encrypted",
          payload: {
            kind: "transactional_sms",
            templateKey: TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED,
            lifecycleStateHash: "f".repeat(64),
          },
        },
      });
      expect(await createService().deliver(tenantId, eventId)).toBe("QUEUED");
      expect(prisma.communicationEvent.updateMany).toHaveBeenLastCalledWith({
        where: { id: eventId, tenantId, status: "SENDING", attemptCount },
        data: {
          status: "QUEUED",
          attemptCount: { decrement: 1 },
          lastErrorCode: "calendar_sync_pending",
          nextAttemptAt: expect.any(Date),
        },
      });
      expect(cipher.decrypt).not.toHaveBeenCalled();
      expect(provider.send).not.toHaveBeenCalled();
    },
  );

  it("does not report a released hold or send when claim ownership changes", async () => {
    prisma.job.findUnique.mockResolvedValue({
      ...lifecycleJob,
      calendarOperations: [{ id: "pending" }],
    });
    prisma.communicationEvent.findUniqueOrThrow.mockResolvedValue({
      tenantId,
      jobId: lifecycleJob.id,
      attemptCount: 1,
      content: {
        payload: {
          kind: "transactional_sms",
          templateKey: TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED,
          lifecycleStateHash: "f".repeat(64),
        },
      },
    });
    prisma.communicationEvent.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await expect(createService().deliver(tenantId, eventId)).rejects.toThrow(
      "claim changed while on hold",
    );
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("revalidates a transactional lifecycle snapshot immediately before send", async () => {
    prisma.communicationEvent.findUniqueOrThrow.mockResolvedValue({
      id: eventId,
      tenantId,
      jobId: lifecycleJob.id,
      attemptCount: 1,
      content: {
        encryptedRaw: "encrypted",
        payload: {
          kind: "transactional_sms",
          templateKey: TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED,
          lifecycleStateHash: transactionalMessageStateHash(
            TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED,
            lifecycleJob,
          ),
        },
      },
    });

    await expect(createService().deliver(tenantId, eventId)).resolves.toBe(
      CommunicationStatus.SENT,
    );
    expect(prisma.job.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id_tenantId: { id: lifecycleJob.id, tenantId },
        },
      }),
    );
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it("dead-letters stale transactional copy before provider access", async () => {
    prisma.communicationEvent.findUniqueOrThrow.mockResolvedValue({
      id: eventId,
      tenantId,
      jobId: lifecycleJob.id,
      attemptCount: 1,
      content: {
        encryptedRaw: "encrypted",
        payload: {
          kind: "transactional_sms",
          templateKey: TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED,
          lifecycleStateHash: "0".repeat(64),
        },
      },
    });

    await expect(createService().deliver(tenantId, eventId)).resolves.toBe(
      CommunicationStatus.DEAD_LETTER,
    );
    expect(prisma.communicationEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: CommunicationStatus.DEAD_LETTER,
          lastErrorCode: "stale_lifecycle_state",
        }),
      }),
    );
    expect(provider.send).not.toHaveBeenCalled();
  });

  it.each(["current", "later_departure", "reassigned", "started"])(
    "revalidates on-the-way delivery for %s state",
    async (state) => {
      const templateKey = TransactionalMessageTemplateKey.TECHNICIAN_ON_THE_WAY;
      const queuedJob = {
        ...lifecycleJob,
        technicianStatus: "EN_ROUTE" as const,
      };
      const currentJob = {
        ...queuedJob,
        ...(state === "later_departure"
          ? { technicianStatusUpdatedAt: new Date("2026-09-09T15:00:00.000Z") }
          : {}),
        ...(state === "reassigned"
          ? { assignedUser: { id: "other-technician", fullName: "Morgan" } }
          : {}),
        ...(state === "started"
          ? { technicianStatus: "IN_PROGRESS" as const }
          : {}),
      };
      prisma.job.findUnique.mockResolvedValue(currentJob);
      prisma.communicationEvent.findUniqueOrThrow.mockResolvedValue({
        id: eventId,
        tenantId,
        jobId: lifecycleJob.id,
        attemptCount: 1,
        content: {
          encryptedRaw: "encrypted",
          payload: {
            kind: "transactional_sms",
            templateKey,
            lifecycleStateHash: transactionalMessageStateHash(
              templateKey,
              queuedJob,
            ),
          },
        },
      });
      await expect(createService().deliver(tenantId, eventId)).resolves.toBe(
        state === "current"
          ? CommunicationStatus.SENT
          : CommunicationStatus.DEAD_LETTER,
      );
      expect(provider.send).toHaveBeenCalledTimes(state === "current" ? 1 : 0);
      if (state !== "current")
        expect(prisma.communicationEvent.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              lastErrorCode: "stale_lifecycle_state",
            }),
          }),
        );
    },
  );

  it("fails closed for earlier transactional records without a state digest", async () => {
    prisma.communicationEvent.findUniqueOrThrow.mockResolvedValue({
      id: eventId,
      tenantId,
      jobId: lifecycleJob.id,
      attemptCount: 1,
      content: {
        encryptedRaw: "encrypted",
        payload: {
          kind: "transactional_sms",
          templateKey: TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED,
        },
      },
    });

    await expect(createService().deliver(tenantId, eventId)).resolves.toBe(
      CommunicationStatus.DEAD_LETTER,
    );
    expect(prisma.communicationEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastErrorCode: "lifecycle_state_unavailable",
        }),
      }),
    );
    expect(prisma.job.findUnique).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("prevents concurrent or duplicate delivery claims", async () => {
    prisma.communicationEvent.updateMany.mockResolvedValue({ count: 0 });
    await expect(createService().deliver(tenantId, eventId)).rejects.toThrow(
      ConflictException,
    );
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("schedules a bounded retry only for an explicit retry-safe rejection", async () => {
    provider.send.mockRejectedValue(
      new SmsProviderError("busy", "http_429", true),
    );
    await expect(createService().deliver(tenantId, eventId)).resolves.toBe(
      CommunicationStatus.FAILED,
    );
    expect(prisma.communicationEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: CommunicationStatus.FAILED,
          lastErrorCode: "http_429",
          nextAttemptAt: expect.any(Date),
        }),
      }),
    );
  });

  it("dead-letters ambiguous outcomes instead of risking a duplicate send", async () => {
    provider.send.mockRejectedValue(
      new SmsProviderError("timeout", "ambiguous_transport", false),
    );
    await expect(createService().deliver(tenantId, eventId)).resolves.toBe(
      CommunicationStatus.DEAD_LETTER,
    );
    expect(prisma.communicationEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: CommunicationStatus.DEAD_LETTER,
          lastErrorCode: "ambiguous_transport",
        }),
      }),
    );
  });

  it("applies duplicate callbacks idempotently and never regresses delivered", async () => {
    prisma.communicationEvent.findUnique.mockResolvedValue({
      id: eventId,
      status: CommunicationStatus.DELIVERED,
    });
    const service = createService();
    await service.applyStatus({
      tenantId,
      externalId: "SM00000000000000000000000000000001",
      providerStatus: "delivered",
    });
    await service.applyStatus({
      tenantId,
      externalId: "SM00000000000000000000000000000001",
      providerStatus: "undelivered",
      errorCode: "30003",
    });
    expect(prisma.communicationEvent.update).not.toHaveBeenCalled();
  });

  it("does not process queued work while delivery is disabled", async () => {
    await expect(createService().processDue()).resolves.toBe(0);
    expect(prisma.communicationEvent.findMany).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("requires duplicate-risk acknowledgment before dead-letter replay", async () => {
    prisma.communicationEvent.findUnique.mockResolvedValue({
      status: CommunicationStatus.DEAD_LETTER,
      lastErrorCode: "ambiguous_transport",
    });

    await expect(
      createService().replayDeadLetter({
        tenantId,
        eventId,
        actorId: "operator-1",
        acknowledgeDuplicateRisk: false,
        reason: "Customer requested a controlled replay.",
      }),
    ).rejects.toThrow(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns privacy-safe tenant delivery metrics", async () => {
    prisma.communicationEvent.findMany.mockResolvedValue([
      {
        status: CommunicationStatus.DELIVERED,
        attemptCount: 1,
        lastErrorCode: null,
      },
      {
        status: CommunicationStatus.DEAD_LETTER,
        attemptCount: 3,
        lastErrorCode: "http_429",
      },
    ]);

    await expect(createService().metrics(tenantId, 30)).resolves.toEqual(
      expect.objectContaining({
        total: 2,
        attempts: 4,
        byStatus: { DELIVERED: 1, DEAD_LETTER: 1 },
        failuresByCode: { http_429: 1 },
        truncated: false,
      }),
    );
    expect(
      JSON.stringify(prisma.communicationEvent.findMany.mock.calls[0]),
    ).not.toContain(to);
  });

  it("returns tenant-scoped template history without message content", async () => {
    prisma.communicationEvent.findMany.mockResolvedValue([
      {
        id: eventId,
        jobId: "20000000-0000-4000-8000-000000000002",
        direction: "OUTBOUND",
        status: CommunicationStatus.DELIVERED,
        attemptCount: 1,
        lastErrorCode: null,
        occurredAt: new Date("2026-09-08T10:00:00.000Z"),
        terminalAt: new Date("2026-09-08T10:00:02.000Z"),
        content: {
          templateId: "transactional_sms:appointment_confirmed:v1",
          payload: {
            templateKey: "APPOINTMENT_CONFIRMED",
            templateVersion: 1,
            recipientHash: "private-hash",
          },
        },
      },
    ]);

    const history = await createService().listHistory({
      tenantId,
      limit: 50,
    });
    expect(history[0]).toEqual(
      expect.objectContaining({
        templateKey: "APPOINTMENT_CONFIRMED",
        templateVersion: 1,
      }),
    );
    expect(JSON.stringify(history)).not.toContain("private-hash");
    expect(JSON.stringify(history)).not.toContain(to);
  });

  function createService(): SmsDeliveryService {
    return new SmsDeliveryService(
      prisma as unknown as PrismaService,
      consent as unknown as SmsConsentService,
      cipher as unknown as ConversationMemoryCipher,
      provider as unknown as SmsProvider,
      {
        twilioWebhookBaseUrl: "https://api.example.test",
        twilioWebhookEnvironment: "staging",
        twilioTenantIdentities: [identity],
        smsConsentHashKey: "x".repeat(32),
        smsDeliveryEnabled: false,
      } as ConfigType<typeof appConfig>,
    );
  }
});
