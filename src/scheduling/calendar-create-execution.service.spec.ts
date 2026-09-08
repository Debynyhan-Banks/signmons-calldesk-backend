import { CalendarCreateExecutionService } from "./calendar-create-execution.service";

describe("inactive one-shot CREATE execution", () => {
  const operation = {
    id: "op",
    tenantId: "tenant",
    jobId: "job",
    action: "CREATE",
    status: "PENDING",
    finishedAt: null,
    calendarId: "saved",
    calendarEventId: "a".repeat(32),
    timeZone: "UTC",
    claimedUpdatedAt: new Date(1),
    updatedAt: new Date(2),
    desiredWindowStart: new Date("2099-01-01"),
    desiredWindowEnd: new Date("2099-01-02"),
    desiredTimeText: "saved label",
  };
  function harness(overrides = {}) {
    let committed = false;
    const tx = {
      calendarOperation: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      job: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      calendarOperation: {
        findUnique: jest.fn().mockResolvedValue({ ...operation, ...overrides }),
        findFirst: jest.fn().mockResolvedValue({ id: "op" }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      job: { findFirst: jest.fn().mockResolvedValue({ id: "job" }) },
      $transaction: jest.fn(
        async (fn: (client: typeof tx) => Promise<unknown>) => {
          const result = await fn(tx);
          committed = true;
          return result;
        },
      ),
    };
    const creator = {
      create: jest.fn().mockImplementation(() => {
        expect(committed).toBe(true);
        return Promise.resolve();
      }),
    };
    const reconciliation = {
      reconcile: jest.fn().mockResolvedValue({ status: "finalized" }),
    };
    return {
      tx,
      prisma,
      creator,
      reconciliation,
      service: new CalendarCreateExecutionService(
        prisma as never,
        creator,
        reconciliation as never,
      ),
    };
  }
  const input = { tenantId: "tenant", operationId: "op" };
  it("commits the attempt latch and new job version before one insert, then reads back", async () => {
    const h = harness();
    expect(await h.service.execute(input)).toEqual({ status: "finalized" });
    expect(h.tx.calendarOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant",
          status: "PENDING",
          updatedAt: operation.updatedAt,
          finishedAt: null,
        }),
        data: expect.objectContaining({
          status: "UNCERTAIN",
          claimedUpdatedAt: expect.any(Date),
        }),
      }),
    );
    expect(h.tx.job.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant",
          updatedAt: operation.claimedUpdatedAt,
          calendarEventId: null,
          assignedUserId: null,
          technicianStatus: null,
        }),
      }),
    );
    expect(h.creator.create).toHaveBeenCalledWith({
      calendarId: "saved",
      eventId: operation.calendarEventId,
      tenantId: "tenant",
      jobId: "job",
      operationId: "op",
      start: operation.desiredWindowStart,
      end: operation.desiredWindowEnd,
      timeZone: "UTC",
    });
    expect(h.reconciliation.reconcile).toHaveBeenCalledWith(input);
  });
  it.each(["UNCERTAIN", "APPLIED", "NEEDS_REVIEW", "FINALIZED", "ABORTED"])(
    "never inserts or races read-back for %s",
    async (status) => {
      const h = harness({
        status,
        finishedAt: ["ABORTED", "FINALIZED"].includes(status)
          ? new Date()
          : null,
      });
      await h.service.execute(input);
      expect(h.creator.create).not.toHaveBeenCalled();
      expect(h.reconciliation.reconcile).not.toHaveBeenCalled();
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each(["RESCHEDULE", "CANCEL"])("rejects %s", async (action) => {
    const h = harness({ action });
    await expect(h.service.execute(input)).rejects.toThrow("Only initial");
    expect(h.creator.create).not.toHaveBeenCalled();
  });
  it("uses tenant-bound lookup and rejects missing authority", async () => {
    const h = harness();
    h.prisma.calendarOperation.findUnique.mockResolvedValue(null);
    await expect(h.service.execute(input)).rejects.toThrow("not found");
    expect(h.prisma.calendarOperation.findUnique).toHaveBeenCalledWith({
      where: { id_tenantId: { id: "op", tenantId: "tenant" } },
    });
  });
  it.each([
    { desiredWindowStart: new Date(0) },
    { calendarEventId: "unsafe/new" },
    { desiredWindowEnd: new Date(0) },
  ])("holds invalid target/window %j without insert", async (overrides) => {
    const h = harness(overrides);
    expect(await h.service.execute(input)).toEqual({ status: "needs_review" });
    expect(h.creator.create).not.toHaveBeenCalled();
  });
  it("does not insert after losing the conditional latch", async () => {
    const h = harness();
    h.tx.calendarOperation.updateMany.mockResolvedValue({ count: 0 });
    expect(await h.service.execute(input)).toEqual({ status: "pending" });
    expect(h.tx.job.updateMany).not.toHaveBeenCalled();
    expect(h.creator.create).not.toHaveBeenCalled();
  });
  it("holds a stale/ineligible job before attempting", async () => {
    const h = harness();
    h.tx.job.updateMany.mockResolvedValue({ count: 0 });
    expect(await h.service.execute(input)).toEqual({ status: "needs_review" });
    expect(h.creator.create).not.toHaveBeenCalled();
  });
  it("does not insert after a commit outcome becomes unknown", async () => {
    const h = harness();
    h.prisma.$transaction.mockRejectedValue(new Error("unknown commit"));
    await expect(h.service.execute(input)).rejects.toThrow("unknown commit");
    expect(h.creator.create).not.toHaveBeenCalled();
  });
  it("does not insert after a newer journal review decision", async () => {
    const h = harness();
    h.prisma.calendarOperation.findFirst.mockResolvedValue(null);
    expect(await h.service.execute(input)).toEqual({ status: "needs_review" });
    expect(h.creator.create).not.toHaveBeenCalled();
  });

  it("holds a job changed after the attempt transaction", async () => {
    const h = harness();
    h.prisma.job.findFirst.mockResolvedValue(null);
    expect(await h.service.execute(input)).toEqual({ status: "needs_review" });
    expect(h.creator.create).not.toHaveBeenCalled();
  });
  it("requires read-back even when the insert throws", async () => {
    const h = harness();
    h.creator.create.mockRejectedValue(new Error("private provider failure"));
    h.reconciliation.reconcile.mockResolvedValue({ status: "needs_review" });
    expect(await h.service.execute(input)).toEqual({ status: "needs_review" });
    expect(h.creator.create).toHaveBeenCalledTimes(1);
    expect(h.reconciliation.reconcile).toHaveBeenCalledTimes(1);
  });
  it("does not reinsert or compensate when read-back fails", async () => {
    const h = harness();
    h.reconciliation.reconcile.mockRejectedValue(
      new Error("read persistence failed"),
    );
    await expect(h.service.execute(input)).rejects.toThrow(
      "read persistence failed",
    );
    expect(h.creator.create).toHaveBeenCalledTimes(1);
  });
});
