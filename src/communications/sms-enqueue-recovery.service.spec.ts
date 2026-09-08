import { SmsEnqueueRecoveryService } from "./sms-enqueue-recovery.service";
import { EnqueueRetryReason } from "./sms-enqueue-intent-policy";
import { TransactionalMessageTemplateKey } from "./transactional-message-template.service";
import { transactionalMessageStateHash } from "./transactional-message-state";

describe("SmsEnqueueRecoveryService", () => {
  const now = new Date("2026-09-08T12:00:00.000Z");
  const input = {
    tenantId: "tenant-1",
    intentId: "intent-1",
    actorId: "owner-1",
    acknowledgeRetry: true,
    reasonCode: EnqueueRetryReason.CONFIGURATION_REVIEWED,
    expectedUpdatedAt: now.toISOString(),
  };
  const templateKey = TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED;
  const job = {
    id: "job-1",
    status: "ACCEPTED",
    deletedAt: null,
    technicianStatus: null,
    technicianStatusUpdatedAt: null,
    calendarEventId: "calendar-1",
    serviceWindowStart: now,
    serviceWindowEnd: new Date(now.getTime() + 60_000),
    tenant: { name: "Fixture", timezone: "UTC" },
    customer: { phone: "+15555550123" },
    assignedUser: null,
  } as const;
  const record = {
    id: input.intentId,
    tenantId: input.tenantId,
    jobId: job.id,
    templateKey,
    stateHash: transactionalMessageStateHash(templateKey, job),
    status: "FAILED",
    attemptCount: 5,
    communicationEventId: null,
    updatedAt: now,
  };
  function harness() {
    const transaction = {
      smsEnqueueIntent: {
        findUnique: jest.fn().mockResolvedValue(record),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      job: { findUnique: jest.fn().mockResolvedValue(job) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: jest.fn(
        (callback: (tx: typeof transaction) => Promise<void>) =>
          callback(transaction),
      ),
    };
    return {
      transaction,
      prisma,
      service: new SmsEnqueueRecoveryService(prisma as never),
    };
  }
  it("re-arms exhausted work and audits the same transaction without transport access", async () => {
    const { transaction, service } = harness();
    await expect(service.retry(input)).resolves.toEqual({ status: "pending" });
    expect(transaction.smsEnqueueIntent.findUnique).toHaveBeenCalledWith({
      where: { id_tenantId: { id: input.intentId, tenantId: input.tenantId } },
    });
    expect(transaction.job.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id_tenantId: { id: job.id, tenantId: input.tenantId } },
      }),
    );
    expect(transaction.smsEnqueueIntent.updateMany).toHaveBeenCalledWith({
      where: {
        id: input.intentId,
        tenantId: input.tenantId,
        status: "FAILED",
        attemptCount: 5,
        communicationEventId: null,
        updatedAt: now,
      },
      data: {
        status: "PENDING",
        attemptCount: 0,
        lastErrorCode: null,
        nextAttemptAt: expect.any(Date),
      },
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: input.tenantId,
        action: "communication.enqueue_intent_retry_requested",
        actorType: "USER",
        actorId: input.actorId,
        entityType: "SmsEnqueueIntent",
        entityId: input.intentId,
        metadata: {
          jobId: job.id,
          templateKey,
          reasonCode: input.reasonCode,
          acknowledged: true,
          previousAttemptCount: 5,
          reviewedUpdatedAt: input.expectedUpdatedAt,
        },
      },
    });
    expect(
      JSON.stringify(transaction.auditLog.create.mock.calls),
    ).not.toContain(job.customer.phone);
    expect(
      JSON.stringify(transaction.auditLog.create.mock.calls),
    ).not.toContain(record.stateHash);
  });
  it.each([
    { acknowledgeRetry: false },
    { reasonCode: "arbitrary" },
    { expectedUpdatedAt: "invalid" },
    { expectedUpdatedAt: "2026-09-08" },
  ])(
    "rejects invalid acknowledgment/reason/timestamp before reading: %j",
    async (overrides) => {
      const { service, prisma } = harness();
      await expect(
        service.retry({ ...input, ...overrides } as typeof input),
      ).rejects.toThrow("Retry requires");
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it("maps missing/cross-tenant records to not found", async () => {
    const { service, transaction } = harness();
    transaction.smsEnqueueIntent.findUnique.mockResolvedValue(null);
    await expect(service.retry(input)).rejects.toThrow("not found");
    expect(transaction.smsEnqueueIntent.updateMany).not.toHaveBeenCalled();
  });
  it.each([
    { status: "PENDING" },
    { status: "QUEUED" },
    { status: "STALE" },
    { attemptCount: 4 },
    { communicationEventId: "event-1" },
    { updatedAt: new Date(0) },
  ])("rejects ineligible or stale reviewed records: %j", async (overrides) => {
    const { service, transaction } = harness();
    transaction.smsEnqueueIntent.findUnique.mockResolvedValue({
      ...record,
      ...overrides,
    });
    await expect(service.retry(input)).rejects.toThrow("current exhausted");
    expect(transaction.smsEnqueueIntent.updateMany).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...job, deletedAt: now },
    { ...job, status: "CANCELLED" },
    { ...job, customer: { phone: "+15555550456" } },
    { ...job, serviceWindowEnd: new Date(now.getTime() + 120_000) },
  ])(
    "refuses missing/incompatible/changed canonical state: %j",
    async (current) => {
      const { service, transaction } = harness();
      transaction.job.findUnique.mockResolvedValue(current);
      await expect(service.retry(input)).rejects.toThrow("no longer matches");
      expect(transaction.smsEnqueueIntent.updateMany).not.toHaveBeenCalled();
    },
  );
  it("rejects unsupported templates without resetting", async () => {
    const { service, transaction } = harness();
    transaction.smsEnqueueIntent.findUnique.mockResolvedValue({
      ...record,
      templateKey: "APPOINTMENT_RESCHEDULED",
    });
    await expect(service.retry(input)).rejects.toThrow("no longer matches");
    expect(transaction.smsEnqueueIntent.updateMany).not.toHaveBeenCalled();
  });
  it("does not audit when another request wins the conditional update", async () => {
    const { service, transaction } = harness();
    transaction.smsEnqueueIntent.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.retry(input)).rejects.toThrow("changed during review");
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });
  it("propagates audit failure so the transaction rolls back", async () => {
    const { service, transaction } = harness();
    transaction.auditLog.create.mockRejectedValue(
      new Error("audit unavailable"),
    );
    await expect(service.retry(input)).rejects.toThrow("audit unavailable");
  });
});
