import { SmsEnqueueIntentStatus } from "@prisma/client";
import { SmsEnqueueIntentService } from "./sms-enqueue-intent.service";
import { StaleMessageIntentError } from "./transactional-messaging.service";
import { TransactionalMessageTemplateKey } from "./transactional-message-template.service";

describe("SmsEnqueueIntentService", () => {
  const now = new Date("2026-09-08T12:00:00Z");
  const intent = {
    id: "intent-1",
    tenantId: "tenant-1",
    jobId: "job-1",
    templateKey: TransactionalMessageTemplateKey.TECHNICIAN_ON_THE_WAY,
    stateHash: "a".repeat(64),
    status: SmsEnqueueIntentStatus.PENDING,
    attemptCount: 0,
    nextAttemptAt: now,
  };
  function harness(enabled = true) {
    const prisma = {
      smsEnqueueIntent: {
        findMany: jest.fn().mockResolvedValue([intent]),
        findUnique: jest.fn().mockResolvedValue(intent),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        upsert: jest.fn().mockResolvedValue({ id: intent.id }),
      },
      job: { findUnique: jest.fn() },
    };
    const messaging = {
      queueLifecycle: jest.fn().mockResolvedValue({ id: "event-1" }),
    };
    const service = new SmsEnqueueIntentService(
      prisma as never,
      messaging as never,
      { smsDeliveryEnabled: enabled } as never,
    );
    return { prisma, messaging, service };
  }
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it("does no processing or reads while delivery is disabled", async () => {
    const { prisma, service, messaging } = harness(false);
    expect(await service.processDue()).toBe(0);
    await service.processOne({
      tenantId: intent.tenantId,
      intentId: intent.id,
    });
    expect(prisma.smsEnqueueIntent.findMany).not.toHaveBeenCalled();
    expect(prisma.smsEnqueueIntent.findUnique).not.toHaveBeenCalled();
    expect(messaging.queueLifecycle).not.toHaveBeenCalled();
  });
  it("records only a hash and stable identity through the caller's transaction", async () => {
    const { prisma, service } = harness();
    prisma.job.findUnique.mockResolvedValue({
      id: intent.jobId,
      status: "ACCEPTED",
      deletedAt: null,
      technicianStatus: "EN_ROUTE",
      technicianStatusUpdatedAt: now,
      customer: { phone: "+15555550123" },
      tenant: { name: "Fixture", timezone: "UTC" },
      assignedUser: { id: "tech-1", fullName: "Fixture Tech" },
    });
    await service.recordDeparture(prisma as never, {
      tenantId: intent.tenantId,
      jobId: intent.jobId,
    });
    expect(prisma.job.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id_tenantId: { id: intent.jobId, tenantId: intent.tenantId } },
      }),
    );
    expect(prisma.smsEnqueueIntent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          tenantId: intent.tenantId,
          jobId: intent.jobId,
          templateKey: intent.templateKey,
          stateHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        update: {},
      }),
    );
  });
  it("rejects incompatible intent capture before persistence", async () => {
    const { prisma, service } = harness();
    prisma.job.findUnique.mockResolvedValue(null);
    await expect(
      service.recordDeparture(prisma as never, {
        tenantId: intent.tenantId,
        jobId: intent.jobId,
      }),
    ).rejects.toThrow();
    expect(prisma.smsEnqueueIntent.upsert).not.toHaveBeenCalled();
  });
  it("captures the confirmation digest only after a complete calendar reference exists", async () => {
    const { prisma, service } = harness();
    const job = {
      id: intent.jobId,
      status: "ACCEPTED",
      deletedAt: null,
      customer: { phone: "+15555550123" },
      tenant: { name: "Fixture", timezone: "UTC" },
      calendarEventId: "calendar-1",
      serviceWindowStart: now,
      serviceWindowEnd: new Date(now.getTime() + 60_000),
    };
    prisma.job.findUnique.mockResolvedValue({ ...job, calendarEventId: null });
    await expect(
      service.recordConfirmation(prisma as never, {
        tenantId: intent.tenantId,
        jobId: intent.jobId,
      }),
    ).rejects.toThrow();
    expect(prisma.smsEnqueueIntent.upsert).not.toHaveBeenCalled();
    prisma.job.findUnique.mockResolvedValue(job);
    await service.recordConfirmation(prisma as never, {
      tenantId: intent.tenantId,
      jobId: intent.jobId,
    });
    expect(prisma.smsEnqueueIntent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          tenantId: intent.tenantId,
          jobId: intent.jobId,
          templateKey: "APPOINTMENT_CONFIRMED",
          stateHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        update: {},
      }),
    );
  });
  it("recovers the fixed confirmation template with its recorded digest", async () => {
    const { prisma, service, messaging } = harness();
    prisma.smsEnqueueIntent.findUnique.mockResolvedValue({
      ...intent,
      templateKey: "APPOINTMENT_CONFIRMED",
    });
    await service.processDue();
    expect(messaging.queueLifecycle).toHaveBeenCalledWith({
      tenantId: intent.tenantId,
      jobId: intent.jobId,
      templateKey: "APPOINTMENT_CONFIRMED",
      expectedStateHash: intent.stateHash,
    });
  });
  it.each(["APPOINTMENT_RESCHEDULED", "APPOINTMENT_CANCELLED", "unknown"])(
    "stops unsupported intent template %s without queue access",
    async (templateKey) => {
      const { prisma, service, messaging } = harness();
      prisma.smsEnqueueIntent.findUnique.mockResolvedValue({
        ...intent,
        templateKey,
      });
      await service.processDue();
      expect(messaging.queueLifecycle).not.toHaveBeenCalled();
      expect(prisma.smsEnqueueIntent.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "STALE" }),
        }),
      );
    },
  );
  it("claims a due record and queues only the recorded state", async () => {
    const { prisma, messaging, service } = harness();
    expect(await service.processDue()).toBe(1);
    expect(messaging.queueLifecycle).toHaveBeenCalledWith({
      tenantId: intent.tenantId,
      jobId: intent.jobId,
      templateKey: intent.templateKey,
      expectedStateHash: intent.stateHash,
    });
    expect(prisma.smsEnqueueIntent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: intent.tenantId,
          nextAttemptAt: new Date(now.getTime() + 60_000),
        }),
        data: {
          status: "QUEUED",
          communicationEventId: "event-1",
          lastErrorCode: null,
        },
      }),
    );
  });
  it("does not queue when another worker wins the lease", async () => {
    const { prisma, messaging, service } = harness();
    prisma.smsEnqueueIntent.updateMany.mockResolvedValue({ count: 0 });
    await service.processDue();
    expect(messaging.queueLifecycle).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...intent, status: "QUEUED" },
    { ...intent, nextAttemptAt: new Date(now.getTime() + 1) },
  ])("skips missing, completed or unexpired intents: %j", async (record) => {
    const { prisma, messaging, service } = harness();
    prisma.smsEnqueueIntent.findUnique.mockResolvedValue(record);
    await service.processOne({
      tenantId: intent.tenantId,
      intentId: intent.id,
    });
    expect(messaging.queueLifecycle).not.toHaveBeenCalled();
    expect(prisma.smsEnqueueIntent.updateMany).not.toHaveBeenCalled();
  });
  it("stops stale intent recovery without retaining an error payload", async () => {
    const { prisma, messaging, service } = harness();
    messaging.queueLifecycle.mockRejectedValue(
      new StaleMessageIntentError("private error"),
    );
    await service.processDue();
    expect(prisma.smsEnqueueIntent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastErrorCode: "stale_lifecycle_state",
        }),
      }),
    );
    expect(
      JSON.stringify(prisma.smsEnqueueIntent.updateMany.mock.calls),
    ).not.toContain("private error");
  });
  it.each([0, 4])(
    "backs off queue failure and stops at five failures (previous %s)",
    async (attemptCount) => {
      const { prisma, messaging, service } = harness();
      prisma.smsEnqueueIntent.findUnique.mockResolvedValue({
        ...intent,
        attemptCount,
      });
      messaging.queueLifecycle.mockRejectedValue(
        new Error("sensitive failure"),
      );
      await service.processDue();
      expect(prisma.smsEnqueueIntent.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: attemptCount === 4 ? "FAILED" : "PENDING",
            attemptCount: attemptCount + 1,
            lastErrorCode: "enqueue_failed",
            nextAttemptAt: new Date(
              now.getTime() + 60_000 * 2 ** (attemptCount + 1),
            ),
          }),
        }),
      );
    },
  );
  it("restricts operator listing and omits state hashes and message content", async () => {
    const { prisma, service } = harness();
    await service.list("tenant-2");
    expect(prisma.smsEnqueueIntent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: "tenant-2" },
        take: 100,
        select: expect.not.objectContaining({ stateHash: true }),
      }),
    );
  });
});
