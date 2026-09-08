import { AppointmentConfirmationService } from "./appointment-confirmation.service";

describe("AppointmentConfirmationService", () => {
  const input = {
    tenantId: "tenant-1",
    jobId: "job-1",
    start: new Date("2026-09-10T15:00:00Z"),
    end: new Date("2026-09-10T18:00:00Z"),
    calendarEventId: "calendar-1",
  };
  function harness() {
    let committed = false;
    const transaction = {
      job: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: input.jobId, customerId: "customer-1" }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: jest.fn(
        async (callback: (tx: typeof transaction) => Promise<unknown>) => {
          const result = await callback(transaction);
          committed = true;
          return result;
        },
      ),
    };
    const intents = {
      recordConfirmation: jest.fn().mockResolvedValue({ id: "intent-1" }),
      processOne: jest.fn().mockImplementation(() => {
        expect(committed).toBe(true);
        return Promise.resolve();
      }),
    };
    const logging = { error: jest.fn() };
    const service = new AppointmentConfirmationService(
      prisma as never,
      intents as never,
      logging as never,
    );
    return { service, prisma, transaction, intents, logging };
  }
  it("atomically captures calendar reference, intent and audit before processing", async () => {
    const { service, transaction, intents } = harness();
    await expect(service.finalize(input)).resolves.toEqual({
      id: input.jobId,
      customerId: "customer-1",
    });
    expect(transaction.job.updateMany).toHaveBeenCalledWith({
      where: {
        id: input.jobId,
        tenantId: input.tenantId,
        status: "ACCEPTED",
        deletedAt: null,
        calendarOperations: { none: { finishedAt: null } },
        calendarEventId: null,
        serviceWindowStart: input.start,
        serviceWindowEnd: input.end,
      },
      data: { calendarEventId: input.calendarEventId },
    });
    expect(intents.recordConfirmation).toHaveBeenCalledWith(transaction, {
      tenantId: input.tenantId,
      jobId: input.jobId,
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: input.tenantId,
        action: "appointment.initial_confirmed",
        actorType: "CUSTOMER",
        actorId: "customer:customer-1",
        entityType: "Job",
        entityId: input.jobId,
        metadata: { notificationIntentId: "intent-1" },
      },
    });
    expect(intents.processOne).toHaveBeenCalledWith({
      tenantId: input.tenantId,
      intentId: "intent-1",
    });
  });
  it("rejects changed/cross-tenant reservations without intent capture", async () => {
    const { service, transaction, intents } = harness();
    transaction.job.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.finalize(input)).rejects.toThrow(
      "reservation changed",
    );
    expect(intents.recordConfirmation).not.toHaveBeenCalled();
    expect(intents.processOne).not.toHaveBeenCalled();
  });
  it.each(["intent", "audit", "commit"])(
    "does not process after %s failure",
    async (failure) => {
      const { service, prisma, transaction, intents } = harness();
      if (failure === "intent")
        intents.recordConfirmation.mockRejectedValue(new Error("failed"));
      if (failure === "audit")
        transaction.auditLog.create.mockRejectedValue(new Error("failed"));
      if (failure === "commit")
        prisma.$transaction.mockImplementation(async (callback) => {
          await callback(transaction);
          throw new Error("failed");
        });
      await expect(service.finalize(input)).rejects.toThrow("failed");
      expect(intents.processOne).not.toHaveBeenCalled();
    },
  );
  it("isolates post-commit enqueue and logging failures", async () => {
    const { service, intents, logging } = harness();
    intents.processOne.mockRejectedValue(new Error("PRIVATE_QUEUE_ERROR"));
    logging.error.mockImplementation(() => {
      throw new Error("failed");
    });
    await expect(service.finalize(input)).resolves.toEqual({
      id: input.jobId,
      customerId: "customer-1",
    });
    expect(JSON.stringify(logging.error.mock.calls)).not.toContain(
      "PRIVATE_QUEUE_ERROR",
    );
  });
});
