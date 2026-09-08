import { AppointmentReschedulingService } from "./appointment-rescheduling.service";

describe("AppointmentReschedulingService", () => {
  const claim = {
    id: "job",
    tenantId: "tenant",
    customerId: "customer",
    updatedAt: new Date("2026-09-08T12:00:00.000Z"),
    calendarEventId: "event",
    serviceWindowStart: new Date(1),
    serviceWindowEnd: new Date(2),
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
      recordReschedule: jest.fn().mockResolvedValue({ id: "intent" }),
      processOne: jest.fn().mockImplementation(() => {
        expect(committed).toBe(true);
        return Promise.resolve();
      }),
    };
    const logging = { error: jest.fn() };
    const service = new AppointmentReschedulingService(
      prisma as never,
      intents as never,
      logging as never,
    );
    return { service, prisma, tx, intents, logging };
  }
  const where = {
    id: "job",
    tenantId: "tenant",
    deletedAt: null,
    status: "ACCEPTED",
    calendarEventId: "event",
    serviceWindowStart: new Date(1),
    serviceWindowEnd: new Date(2),
    updatedAt: claim.updatedAt,
  };
  it("claims the exact tenant/job/window/version without recording any intent or audit", async () => {
    const { service, tx, intents } = harness();
    await service.claim(claim as never, new Date(3), new Date(4), "next");
    expect(tx.job.updateMany).toHaveBeenCalledWith({
      where,
      data: {
        serviceWindowStart: new Date(3),
        serviceWindowEnd: new Date(4),
        preferredTimeText: "next",
        updatedAt: expect.any(Date),
      },
    });
    expect(intents.recordReschedule).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it("finalizes intent and customer activity atomically before processing", async () => {
    const { service, tx, intents } = harness();
    await service.finalize(claim as never, "previous", "next");
    expect(tx.job.updateMany).toHaveBeenCalledWith({
      where,
      data: { updatedAt: expect.any(Date) },
    });
    expect(intents.recordReschedule).toHaveBeenCalledWith(tx, {
      tenantId: "tenant",
      jobId: "job",
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: "tenant",
        action: "appointment.customer_rescheduled",
        actorType: "CUSTOMER",
        actorId: "customer:customer",
        entityType: "Job",
        entityId: "job",
        metadata: {
          previousAppointmentLabel: "previous",
          appointmentLabel: "next",
          notificationIntentId: "intent",
          finalizedUpdatedAt: expect.any(String),
        },
      },
    });
  });
  it.each(["claim", "finalize", "restore"] as const)(
    "advances %s version even within one clock millisecond",
    async (method) => {
      const { service, tx } = harness();
      const clock = jest
        .spyOn(Date, "now")
        .mockReturnValue(claim.updatedAt.getTime());
      try {
        if (method === "claim")
          await service.claim(claim as never, new Date(3), new Date(4), "next");
        else if (method === "finalize")
          await service.finalize(claim as never, "old", "next");
        else await service.restore(claim as never, claim as never);
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
    },
  );
  it.each(["claim", "finalize"] as const)(
    "rejects stale/missing/cross-tenant %s before capture",
    async (method) => {
      const { service, tx, intents } = harness();
      tx.job.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        method === "claim"
          ? service.claim(claim as never, new Date(3), new Date(4), "next")
          : service.finalize(claim as never, "old", "next"),
      ).rejects.toThrow("changed");
      expect(intents.recordReschedule).not.toHaveBeenCalled();
      expect(intents.processOne).not.toHaveBeenCalled();
    },
  );
  it.each(["intent", "audit", "commit"])(
    "does not process after %s failure",
    async (failure) => {
      const { service, prisma, tx, intents } = harness();
      if (failure === "intent")
        intents.recordReschedule.mockRejectedValue(new Error("failed"));
      if (failure === "audit")
        tx.auditLog.create.mockRejectedValue(new Error("failed"));
      if (failure === "commit")
        prisma.$transaction.mockImplementation(async (callback) => {
          await callback(tx);
          throw new Error("failed");
        });
      await expect(
        service.finalize(claim as never, "old", "next"),
      ).rejects.toThrow("failed");
      expect(intents.processOne).not.toHaveBeenCalled();
    },
  );
  it("isolates post-commit worker and logging failure", async () => {
    const { service, intents, logging } = harness();
    intents.processOne.mockRejectedValue(new Error("PRIVATE_ERROR"));
    logging.error.mockImplementation(() => {
      throw new Error("failed");
    });
    await expect(
      service.finalize(claim as never, "old", "next"),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(logging.error.mock.calls)).not.toContain(
      "PRIVATE_ERROR",
    );
  });
  it("compensates only the claimed version and active window", async () => {
    const { service, tx } = harness();
    await service.restore(
      claim as never,
      {
        serviceWindowStart: new Date(3),
        serviceWindowEnd: new Date(4),
        preferredTimeText: "old",
      } as never,
    );
    expect(tx.job.updateMany).toHaveBeenCalledWith({
      where,
      data: {
        serviceWindowStart: new Date(3),
        serviceWindowEnd: new Date(4),
        preferredTimeText: "old",
        updatedAt: expect.any(Date),
      },
    });
  });
  it("requires audit proof bound to the current tenant and exact finalized version", async () => {
    const { service, tx } = harness();
    await service.assertFinalized(claim as never);
    expect(tx.auditLog.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant",
        entityType: "Job",
        entityId: "job",
        action: "appointment.customer_rescheduled",
        actorType: "CUSTOMER",
        metadata: {
          path: ["finalizedUpdatedAt"],
          equals: claim.updatedAt.toISOString(),
        },
      },
      select: { id: true },
    });
    tx.auditLog.findFirst.mockResolvedValue(null);
    await expect(service.assertFinalized(claim as never)).rejects.toThrow(
      "office",
    );
  });
});
