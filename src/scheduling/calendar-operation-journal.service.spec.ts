import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CalendarOperationJournalService } from "./calendar-operation-journal.service";
import { PrismaService } from "../prisma/prisma.service";

describe("Calendar operation journal foundation", () => {
  const now = new Date("2026-09-08T18:00:00.000Z");
  const start = new Date("2026-10-01T14:00:00.000Z");
  const end = new Date("2026-10-01T15:00:00.000Z");
  const input = {
    tenantId: "tenant",
    jobId: "job",
    expectedUpdatedAt: now,
    calendarId: "fixture@example.invalid",
    timeZone: "America/New_York",
    action: "CREATE" as const,
    start,
    end,
    label: "Thursday arrival",
  };
  let original: Record<string, unknown>;
  let tx: {
    job: { findFirst: jest.Mock; updateMany: jest.Mock };
    calendarOperation: { findFirst: jest.Mock; create: jest.Mock };
  };
  let service: CalendarOperationJournalService;
  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(now.getTime());
    original = {
      id: "job",
      tenantId: "tenant",
      updatedAt: now,
      status: "CREATED",
      calendarEventId: null,
      serviceWindowStart: null,
      serviceWindowEnd: null,
      preferredTimeText: null,
    };
    tx = {
      job: {
        findFirst: jest
          .fn()
          .mockImplementation(() => Promise.resolve(original)),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      calendarOperation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve(data)),
      },
    };
    service = new CalendarOperationJournalService({
      $transaction: (callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
    } as unknown as PrismaService);
  });
  afterEach(() => jest.restoreAllMocks());

  it("captures a stable create ID, original snapshot and advanced claim version", async () => {
    const record = await service.reserve(input);
    expect(record.calendarEventId).toMatch(/^[0-9a-f]{32}$/);
    expect(record).toMatchObject({
      action: "CREATE",
      previousStatus: "CREATED",
      previousCalendarEventId: null,
      desiredWindowStart: start,
      expectedUpdatedAt: now,
      claimedUpdatedAt: new Date(now.getTime() + 1),
    });
    expect(tx.job.findFirst).toHaveBeenCalledWith({
      where: { id: "job", tenantId: "tenant", deletedAt: null, updatedAt: now },
      include: {
        payment: { select: { id: true, status: true, updatedAt: true } },
      },
    });
    expect(tx.job.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          calendarEventId: null,
          status: "ACCEPTED",
        }),
      }),
    );
    expect(tx.job.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.calendarOperation.create.mock.invocationCallOrder[0],
    );
  });

  it.each(["RESCHEDULE", "CANCEL"] as const)(
    "retains the original external target for %s",
    async (action) => {
      Object.assign(original, {
        policySnapshot: { depositRequired: true },
        payment: { id: "refunded", status: "REFUNDED", updatedAt: now },
        status: "ACCEPTED",
        calendarEventId: "existing-event",
        serviceWindowStart: now,
        serviceWindowEnd: new Date(now.getTime() + 3600000),
        preferredTimeText: "Original window",
      });
      const record = await service.reserve({ ...input, action });
      expect(tx.job.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ payment: undefined }),
        }),
      );
      expect(record).toMatchObject({
        action,
        calendarEventId: "existing-event",
        previousCalendarEventId: "existing-event",
        previousWindowStart: now,
        previousTimeText: "Original window",
      });
      expect(record.desiredWindowStart).toEqual(
        action === "CANCEL" ? null : start,
      );
      if (action === "CANCEL")
        expect(tx.job.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: "CANCELLED",
              calendarEventId: null,
              serviceWindowStart: null,
            }),
          }),
        );
    },
  );

  describe.each(["depositRequired", "serviceFeeRequired"])(
    "CREATE %s",
    (required) => {
      it.each([null, "PENDING", "FAILED", "CANCELED", "REFUNDED", "UNKNOWN"])(
        "rejects unpaid state %s before writes",
        async (status) => {
          original.policySnapshot = { [required]: true };
          original.payment = status
            ? { id: "payment", status, updatedAt: now }
            : null;
          await expect(service.reserve(input)).rejects.toBeInstanceOf(
            ConflictException,
          );
          expect(tx.job.updateMany).not.toHaveBeenCalled();
          expect(tx.calendarOperation.create).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("claims only the exact canonical successful payment, without persisting payment details", async () => {
    original.policySnapshot = { depositRequired: true };
    original.payment = { id: "payment", status: "SUCCEEDED", updatedAt: now };
    const result = await service.reserve(input);
    expect(tx.job.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          payment: {
            is: {
              id: "payment",
              tenantId: "tenant",
              status: "SUCCEEDED",
              updatedAt: now,
            },
          },
        }),
      }),
    );
    expect(result).not.toHaveProperty("payment");
    expect(result).not.toHaveProperty("policySnapshot");
  });

  it.each([false, true])(
    "preserves no-requirement/approved-exception semantics: %s",
    async (exception) => {
      original.policySnapshot = exception
        ? {
            depositRequired: true,
            paymentGateMode: "manual_override",
            paymentGateException: {
              active: true,
              approvedAt: now.toISOString(),
              reason: "Approved synthetic exception",
            },
          }
        : { depositRequired: false, serviceFeeRequired: false };
      original.payment = { id: "payment", status: "FAILED", updatedAt: now };
      await service.reserve(input);
      expect(tx.job.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            payment: undefined,
            updatedAt: now,
          }),
        }),
      );
    },
  );

  it("rejects a revoked exception without a payment claim", async () => {
    original.policySnapshot = {
      depositRequired: true,
      paymentGateMode: "manual_override",
      paymentGateException: {
        active: false,
        approvedAt: now.toISOString(),
        reason: "Revoked",
      },
    };
    original.payment = null;
    await expect(service.reserve(input)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.job.updateMany).not.toHaveBeenCalled();
    expect(tx.calendarOperation.create).not.toHaveBeenCalled();
  });

  it("does not journal a lost payment claim", async () => {
    original.policySnapshot = { serviceFeeRequired: true };
    original.payment = { id: "payment", status: "SUCCEEDED", updatedAt: now };
    tx.job.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.reserve(input)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.calendarOperation.create).not.toHaveBeenCalled();
  });

  it("rejects missing/cross-tenant/stale snapshots before reservation", async () => {
    tx.job.findFirst.mockResolvedValue(null);
    await expect(service.reserve(input)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.job.updateMany).not.toHaveBeenCalled();
  });
  it.each(["COMPLETED", "CANCELLED", "ACCEPTED", "IN_PROGRESS"])(
    "cannot create over %s",
    async (status) => {
      original.status = status;
      await expect(service.reserve(input)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(tx.calendarOperation.create).not.toHaveBeenCalled();
    },
  );
  it("does not turn a same-window replay into a new operation", async () => {
    Object.assign(original, {
      status: "ACCEPTED",
      calendarEventId: "existing-event",
      serviceWindowStart: start,
      serviceWindowEnd: end,
    });
    await expect(
      service.reserve({ ...input, action: "RESCHEDULE" }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.job.updateMany).not.toHaveBeenCalled();
  });
  it("rejects an incomplete existing Calendar snapshot", async () => {
    original.status = "ACCEPTED";
    await expect(
      service.reserve({ ...input, action: "CANCEL" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it("does not guess or re-arm an unfinished operation", async () => {
    tx.calendarOperation.findFirst.mockResolvedValue({
      id: "uncertain-operation",
    });
    await expect(service.reserve(input)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.job.updateMany).not.toHaveBeenCalled();
  });
  it("rejects a concurrently changed reservation", async () => {
    tx.job.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.reserve(input)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.calendarOperation.create).not.toHaveBeenCalled();
  });
  it("propagates a journal write failure to roll back the caller transaction", async () => {
    tx.calendarOperation.create.mockRejectedValue(new Error("journal failed"));
    await expect(service.reserve(input)).rejects.toThrow("journal failed");
  });
  it("converts a database uniqueness race to a bounded conflict", async () => {
    tx.calendarOperation.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("private database details", {
        code: "P2002",
        clientVersion: "fixture",
      }),
    );
    await expect(service.reserve(input)).rejects.toThrow(
      "Appointment changed or has unfinished Calendar work.",
    );
  });
  it.each([
    { calendarId: " " },
    { timeZone: "invalid-zone" },
    { expectedUpdatedAt: new Date(NaN) },
    { start: new Date(NaN) },
    { end: start },
    { label: " " },
    { label: "x".repeat(161) },
  ])("rejects malformed input before database work: %p", async (invalid) => {
    await expect(
      service.reserve({ ...input, ...invalid }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.job.findFirst).not.toHaveBeenCalled();
  });
});
