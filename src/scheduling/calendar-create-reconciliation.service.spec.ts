import { CalendarOperation, CalendarOperationStatus } from "@prisma/client";
import { recordAppointmentEmailConfirmation } from "../communications/appointment-email-intent";
jest.mock("../communications/appointment-email-intent", () => ({
  recordAppointmentEmailConfirmation: jest
    .fn()
    .mockResolvedValue({ id: "email-intent" }),
}));
import { CalendarCreateReconciliationService } from "./calendar-create-reconciliation.service";
import { PrismaService } from "../prisma/prisma.service";
import { SmsEnqueueIntentService } from "../communications/sms-enqueue-intent.service";
import { CalendarEventSnapshot } from "./calendar-event-reader";

describe("CREATE Calendar read-back reconciliation", () => {
  const date = new Date("2026-09-08T18:00:00Z");
  let operation: CalendarOperation;
  let event: CalendarEventSnapshot;
  let prisma: {
    calendarOperation: { findUnique: jest.Mock; updateMany: jest.Mock };
    job: { findFirst: jest.Mock; updateMany: jest.Mock };
    auditLog: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let reader: { read: jest.Mock };
  let intents: { recordConfirmation: jest.Mock; processOne: jest.Mock };
  let service: CalendarCreateReconciliationService;
  const input = { tenantId: "tenant", operationId: "operation" };
  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(date.getTime() - 1000);
    operation = {
      id: "operation",
      tenantId: "tenant",
      jobId: "job",
      action: "CREATE",
      status: "UNCERTAIN",
      calendarId: "saved-calendar",
      calendarEventId: "a".repeat(32),
      timeZone: "UTC",
      expectedUpdatedAt: new Date(date.getTime() - 1),
      claimedUpdatedAt: date,
      previousStatus: "CREATED",
      previousCalendarEventId: null,
      previousWindowStart: null,
      previousWindowEnd: null,
      previousTimeText: null,
      desiredWindowStart: date,
      desiredWindowEnd: new Date(date.getTime() + 3600000),
      desiredTimeText: "Arrival",
      finishedAt: null,
      readbackNotBefore: null,
      createdAt: date,
      updatedAt: new Date(date.getTime() - 20_000),
    };
    event = {
      id: operation.calendarEventId,
      etag: '"private-etag"',
      status: "confirmed",
      start: date.toISOString(),
      end: operation.desiredWindowEnd!.toISOString(),
      tenantId: "tenant",
      jobId: "job",
      operationId: "operation",
      blockingSingleEvent: true,
    };
    prisma = {
      calendarOperation: {
        findUnique: jest
          .fn()
          .mockImplementation(() => Promise.resolve(operation)),
        updateMany: jest.fn().mockImplementation(({ data }) => {
          operation = { ...operation, ...data };
          return Promise.resolve({ count: 1 });
        }),
      },
      job: {
        findFirst: jest.fn().mockResolvedValue({ id: "job" }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: "audit" }) },
      $transaction: jest
        .fn()
        .mockImplementation(
          async (callback: (tx: typeof prisma) => Promise<unknown>) => {
            const original = operation;
            try {
              return await callback(prisma);
            } catch (error) {
              operation = original;
              throw error;
            }
          },
        ),
    };
    reader = {
      read: jest
        .fn()
        .mockImplementation(() => Promise.resolve({ outcome: "found", event })),
    };
    intents = {
      recordConfirmation: jest.fn().mockResolvedValue({ id: "intent" }),
      processOne: jest.fn(),
    };
    service = new CalendarCreateReconciliationService(
      prisma as unknown as PrismaService,
      reader,
      intents as unknown as SmsEnqueueIntentService,
    );
  });
  afterEach(() => jest.restoreAllMocks());
  it("uses persisted read-back deadline rather than the newly admitted version", async () => {
    operation.readbackNotBefore = new Date(Date.now());
    operation.updatedAt = new Date(Date.now());
    expect(
      await service.reconcile({
        ...input,
        expectedUpdatedAt: operation.updatedAt,
      }),
    ).toEqual({ status: "finalized" });
    expect(reader.read).toHaveBeenCalledTimes(1);
  });
  it.each([1, 10_000])(
    "refuses reads %i ms before the persisted deadline despite an old version",
    async (remaining) => {
      operation.readbackNotBefore = new Date(Date.now() + remaining);
      expect(await service.reconcile(input)).toEqual({ status: "pending" });
      expect(reader.read).not.toHaveBeenCalled();
      expect(prisma.job.findFirst).not.toHaveBeenCalled();
      expect(prisma.calendarOperation.updateMany).not.toHaveBeenCalled();
    },
  );
  it("persists a new read-failure backoff after reviewed UNCERTAIN unavailability", async () => {
    operation.readbackNotBefore = new Date(Date.now() - 1);
    reader.read.mockResolvedValue({ outcome: "unavailable" });
    expect(await service.reconcile(input)).toEqual({ status: "pending" });
    expect(operation.readbackNotBefore?.getTime()).toBe(
      operation.updatedAt.getTime() + 10_000,
    );
  });

  it("rejects a stale reviewed admission before job/provider access or any write", async () => {
    await expect(
      service.reconcile({
        ...input,
        expectedUpdatedAt: new Date(operation.updatedAt.getTime() - 1),
      }),
    ).rejects.toThrow("Calendar operation changed");
    expect(reader.read).not.toHaveBeenCalled();
    expect(prisma.job.findFirst).not.toHaveBeenCalled();
    expect(prisma.calendarOperation.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("does not let a matching reviewed version bypass UNCERTAIN grace", async () => {
    operation.updatedAt = new Date(Date.now());
    expect(
      await service.reconcile({
        ...input,
        expectedUpdatedAt: operation.updatedAt,
      }),
    ).toEqual({ status: "pending" });
    expect(reader.read).not.toHaveBeenCalled();
    expect(prisma.job.findFirst).not.toHaveBeenCalled();
    expect(prisma.calendarOperation.updateMany).not.toHaveBeenCalled();
  });

  it.each(["found", "unverified", "unavailable", "throws"])(
    "leaves unattempted CREATE untouched regardless of hypothetical %s evidence",
    async (outcome) => {
      operation.status = "PENDING";
      const original = { ...operation };
      reader.read.mockImplementation(() => {
        if (outcome === "throws") throw new Error("private provider failure");
        return Promise.resolve({ outcome, event });
      });
      for (const now of [date.getTime() - 1000, date.getTime() + 1000]) {
        jest.mocked(Date.now).mockReturnValue(now);
        await expect(service.reconcile(input)).resolves.toEqual({
          status: "pending",
        });
      }
      expect(operation).toEqual(original);
      expect(reader.read).not.toHaveBeenCalled();
      expect(prisma.job.findFirst).not.toHaveBeenCalled();
      expect(prisma.job.updateMany).not.toHaveBeenCalled();
      expect(prisma.calendarOperation.updateMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(intents.recordConfirmation).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(intents.processOne).not.toHaveBeenCalled();
    },
  );
  it("retains APPLIED read-back compatibility", async () => {
    operation.status = "APPLIED";
    await expect(service.reconcile(input)).resolves.toEqual({
      status: "finalized",
    });
    expect(reader.read).toHaveBeenCalledTimes(1);
  });
  it("does not read or write while an UNCERTAIN executor may still be active", async () => {
    operation.updatedAt = new Date(Date.now());
    await expect(service.reconcile(input)).resolves.toEqual({
      status: "pending",
    });
    expect(reader.read).not.toHaveBeenCalled();
    expect(prisma.job.findFirst).not.toHaveBeenCalled();
    expect(prisma.calendarOperation.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("atomically finalizes a matching observation without processing messages", async () => {
    await expect(service.reconcile(input)).resolves.toEqual({
      status: "finalized",
    });
    expect(reader.read).toHaveBeenCalledWith("saved-calendar", "a".repeat(32));
    expect(prisma.calendarOperation.findUnique).toHaveBeenCalledWith({
      where: { id_tenantId: { id: "operation", tenantId: "tenant" } },
    });
    expect(prisma.calendarOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant",
          updatedAt: new Date(date.getTime() - 20_000),
          finishedAt: null,
        }),
        data: expect.objectContaining({
          status: "FINALIZED",
          updatedAt: new Date(date.getTime() - 1000),
        }),
      }),
    );
    expect(prisma.job.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant",
          updatedAt: operation.claimedUpdatedAt,
          calendarEventId: null,
        }),
        data: expect.objectContaining({
          calendarEventId: operation.calendarEventId,
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: "SYSTEM_AI",
          metadata: {
            calendarEvidence: "MATCHED_CREATE_READBACK",
            calendarOperationId: "operation",
            notificationIntentId: "intent",
            finalizedUpdatedAt: expect.any(String),
            observedEventEtagHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
        }),
      }),
    );
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain(
      "private-etag",
    );
    expect(recordAppointmentEmailConfirmation).toHaveBeenCalledWith(prisma, {
      tenantId: "tenant",
      jobId: "job",
      sourceAuditId: "audit",
    });
    expect(intents.processOne).not.toHaveBeenCalled();
  });
  it("holds an already-started window without a Calendar request", async () => {
    jest.mocked(Date.now).mockReturnValue(date.getTime());
    await expect(service.reconcile(input)).resolves.toEqual({
      status: "needs_review",
    });
    expect(reader.read).not.toHaveBeenCalled();
  });
  it("rechecks time when the window starts during the Calendar read", async () => {
    reader.read.mockImplementation(() => {
      jest.mocked(Date.now).mockReturnValue(date.getTime());
      return Promise.resolve({ outcome: "found", event });
    });
    await expect(service.reconcile(input)).resolves.toEqual({
      status: "needs_review",
    });
    expect(prisma.job.updateMany).not.toHaveBeenCalled();
    expect(intents.recordConfirmation).not.toHaveBeenCalled();
  });
  it("accepts equivalent explicit timezone offsets", async () => {
    event.start = "2026-09-08T14:00:00-04:00";
    await expect(service.reconcile(input)).resolves.toEqual({
      status: "finalized",
    });
  });
  it.each([
    "id",
    "tenantId",
    "jobId",
    "operationId",
    "status",
    "start",
    "end",
    "etag",
  ] as const)("does not adopt mismatched %s", async (key) => {
    event[key] = key === "etag" ? "" : "mismatched";
    await service.reconcile(input);
    expect(prisma.calendarOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "NEEDS_REVIEW" }),
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(intents.recordConfirmation).not.toHaveBeenCalled();
  });
  it("rejects nonblocking/recurring/all-day evidence", async () => {
    event.blockingSingleEvent = false;
    await service.reconcile(input);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("rejects offset-free timestamps", async () => {
    event.start = "2026-09-08T18:00:00";
    await service.reconcile(input);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("hides missing/cross-tenant records and never reads Calendar", async () => {
    prisma.calendarOperation.findUnique.mockResolvedValue(null);
    await expect(service.reconcile(input)).rejects.toThrow("was not found");
    expect(reader.read).not.toHaveBeenCalled();
  });
  it.each(["RESCHEDULE", "CANCEL"] as const)(
    "does not reconcile unsupported %s",
    async (action) => {
      operation.action = action;
      await expect(service.reconcile(input)).rejects.toThrow(
        "Only initial booking",
      );
      expect(reader.read).not.toHaveBeenCalled();
    },
  );
  it.each(["NEEDS_REVIEW", "ABORTED", "FINALIZED"] as const)(
    "never retries held/terminal %s",
    async (status) => {
      operation.status = status;
      operation.finishedAt = status === "NEEDS_REVIEW" ? null : date;
      await expect(service.reconcile(input)).resolves.toEqual({
        status: status === "FINALIZED" ? "already_finalized" : "needs_review",
      });
      expect(reader.read).not.toHaveBeenCalled();
    },
  );
  it("holds a changed/deleted local reservation before external access", async () => {
    prisma.job.findFirst.mockResolvedValue(null);
    await service.reconcile(input);
    expect(reader.read).not.toHaveBeenCalled();
    expect(prisma.job.updateMany).not.toHaveBeenCalled();
  });
  it.each(["unverified", "unavailable"] as const)(
    "does not finalize %s provider outcomes",
    async (outcome) => {
      reader.read.mockResolvedValue({ outcome });
      await service.reconcile(input);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.calendarOperation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: outcome === "unavailable" ? "UNCERTAIN" : "NEEDS_REVIEW",
          }),
        }),
      );
    },
  );
  it("isolates thrown provider errors", async () => {
    reader.read.mockRejectedValue(new Error("private token"));
    await expect(service.reconcile(input)).resolves.toEqual({
      status: "pending",
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each(["journal", "job", "intent", "audit"])(
    "rolls back finalization on %s failure",
    async (target) => {
      if (target === "journal")
        prisma.calendarOperation.updateMany.mockResolvedValueOnce({ count: 0 });
      if (target === "job")
        prisma.job.updateMany.mockResolvedValueOnce({ count: 0 });
      if (target === "intent")
        intents.recordConfirmation.mockRejectedValue(new Error("failed"));
      if (target === "audit")
        prisma.auditLog.create.mockRejectedValue(new Error("failed"));
      await expect(service.reconcile(input)).resolves.toEqual({
        status: ["journal", "job"].includes(target)
          ? "needs_review"
          : "pending",
      });
      expect(prisma.calendarOperation.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ["journal", "job"].includes(target)
              ? "NEEDS_REVIEW"
              : "UNCERTAIN",
          }),
        }),
      );
      expect(intents.processOne).not.toHaveBeenCalled();
    },
  );
  it("recognizes a committed receipt after lost commit acknowledgment", async () => {
    prisma.$transaction.mockImplementation(() => {
      operation = {
        ...operation,
        status: CalendarOperationStatus.FINALIZED,
        finishedAt: date,
      };
      return Promise.reject(new Error("lost acknowledgment"));
    });
    prisma.calendarOperation.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.reconcile(input)).resolves.toEqual({
      status: "already_finalized",
    });
    expect(prisma.job.updateMany).not.toHaveBeenCalled();
  });
});
