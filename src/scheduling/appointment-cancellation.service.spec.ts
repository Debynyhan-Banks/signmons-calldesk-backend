import { AppointmentCancellationService } from "./appointment-cancellation.service";

describe("AppointmentCancellationService", () => {
  const claim = {
    id: "job",
    tenantId: "tenant",
    customerId: "customer",
    updatedAt: new Date("2026-09-08T12:00:00Z"),
    calendarEventId: null,
  };
  function harness() {
    let committed = false;
    const tx = {
      job: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(claim),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue({ id: "audit" }),
      },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) => {
          const result = await callback(tx);
          committed = true;
          return result;
        },
      ),
    };
    const intents = {
      recordCancellation: jest.fn().mockResolvedValue({ id: "intent" }),
      processOne: jest.fn().mockImplementation(() => {
        expect(committed).toBe(true);
        return Promise.resolve();
      }),
    };
    const logging = { error: jest.fn() };
    const service = new AppointmentCancellationService(
      prisma as never,
      intents as never,
      logging as never,
    );
    return { service, prisma, tx, intents, logging };
  }
  it("claims only the original active, undeleted, tenant-bound job version without recording an intent", async () => {
    const { service, tx, intents } = harness();
    await service.claim(
      {
        ...claim,
        calendarEventId: "event",
        serviceWindowStart: new Date(1),
        serviceWindowEnd: new Date(2),
      } as never,
      "window",
    );
    expect(tx.job.updateMany).toHaveBeenCalledWith({
      where: {
        id: "job",
        tenantId: "tenant",
        deletedAt: null,
        calendarOperations: { none: { finishedAt: null } },
        status: "ACCEPTED",
        updatedAt: claim.updatedAt,
        calendarEventId: "event",
        serviceWindowStart: new Date(1),
        serviceWindowEnd: new Date(2),
      },
      data: {
        status: "CANCELLED",
        calendarEventId: null,
        serviceWindowStart: null,
        serviceWindowEnd: null,
        preferredTimeText: "window",
      },
    });
    expect(intents.recordCancellation).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it("records intent and privacy-safe customer audit in the finalization transaction before processing", async () => {
    const { service, tx, intents } = harness();
    await service.finalize(claim as never);
    expect(tx.job.updateMany).toHaveBeenCalledWith({
      where: {
        id: "job",
        tenantId: "tenant",
        deletedAt: null,
        calendarOperations: { none: { finishedAt: null } },
        status: "CANCELLED",
        calendarEventId: null,
        serviceWindowStart: null,
        serviceWindowEnd: null,
        updatedAt: claim.updatedAt,
      },
      data: { status: "CANCELLED", updatedAt: expect.any(Date) },
    });
    expect(intents.recordCancellation).toHaveBeenCalledWith(tx, {
      tenantId: "tenant",
      jobId: "job",
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: "tenant",
        action: "appointment.customer_cancelled",
        actorType: "CUSTOMER",
        actorId: "customer:customer",
        entityType: "Job",
        entityId: "job",
        metadata: { notificationIntentId: "intent" },
      },
    });
  });
  it("advances the version even within one clock millisecond", async () => {
    const { service, tx } = harness();
    const clock = jest
      .spyOn(Date, "now")
      .mockReturnValue(claim.updatedAt.getTime());
    try {
      await service.finalize(claim as never);
      expect(tx.job.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            updatedAt: new Date(claim.updatedAt.getTime() + 1),
          }),
        }),
      );
    } finally {
      clock.mockRestore();
    }
  });
  it.each(["claim", "finalize"] as const)(
    "refuses stale/changed/cross-tenant %s without notification",
    async (method) => {
      const { service, tx, intents } = harness();
      tx.job.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        method === "claim"
          ? service.claim(claim as never, "window")
          : service.finalize(claim as never),
      ).rejects.toThrow("changed");
      expect(intents.recordCancellation).not.toHaveBeenCalled();
      expect(intents.processOne).not.toHaveBeenCalled();
    },
  );
  it.each(["intent", "audit", "commit"])(
    "does not process on %s failure",
    async (failure) => {
      const { service, prisma, tx, intents } = harness();
      if (failure === "intent")
        intents.recordCancellation.mockRejectedValue(new Error("failed"));
      if (failure === "audit")
        tx.auditLog.create.mockRejectedValue(new Error("failed"));
      if (failure === "commit")
        prisma.$transaction.mockImplementation(async (callback) => {
          await callback(tx);
          throw new Error("failed");
        });
      await expect(service.finalize(claim as never)).rejects.toThrow("failed");
      expect(intents.processOne).not.toHaveBeenCalled();
    },
  );
  it("isolates post-commit processing and logging failures", async () => {
    const { service, intents, logging } = harness();
    intents.processOne.mockRejectedValue(new Error("PRIVATE_ERROR"));
    logging.error.mockImplementation(() => {
      throw new Error("failed");
    });
    await expect(service.finalize(claim as never)).resolves.toBeUndefined();
    expect(JSON.stringify(logging.error.mock.calls)).not.toContain(
      "PRIVATE_ERROR",
    );
  });
  it("bounds compensation to the exact claim, never a newer cancellation", async () => {
    const { service, tx } = harness();
    await service.restore(
      claim as never,
      {
        calendarEventId: "event",
        serviceWindowStart: new Date(1),
        serviceWindowEnd: new Date(2),
        preferredTimeText: "window",
      } as never,
    );
    expect(tx.job.updateMany).toHaveBeenCalledWith({
      where: {
        id: "job",
        tenantId: "tenant",
        deletedAt: null,
        calendarOperations: { none: { finishedAt: null } },
        status: "CANCELLED",
        calendarEventId: null,
        updatedAt: claim.updatedAt,
      },
      data: {
        status: "ACCEPTED",
        calendarEventId: "event",
        serviceWindowStart: new Date(1),
        serviceWindowEnd: new Date(2),
        preferredTimeText: "window",
      },
    });
  });
  it("requires tenant-bound finalization audit for cancellation replay", async () => {
    const { service, tx } = harness();
    await expect(
      service.assertFinalized(claim as never),
    ).resolves.toBeUndefined();
    expect(tx.auditLog.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant",
        entityType: "Job",
        entityId: "job",
        action: "appointment.customer_cancelled",
        actorType: "CUSTOMER",
      },
      select: { id: true },
    });
    tx.auditLog.findFirst.mockResolvedValue(null);
    await expect(service.assertFinalized(claim as never)).rejects.toThrow(
      "office",
    );
  });
});
