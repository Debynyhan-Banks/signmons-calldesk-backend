import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as context from "../common/context/request-context";
import { PrismaService } from "../prisma/prisma.service";
import { CalendarPendingReviewService } from "./calendar-pending-review.service";

describe("Inactive PENDING CREATE office review", () => {
  const now = new Date("2039-01-01T12:00:00.000Z");
  const input = {
    operationId: "11111111-1111-4111-8111-111111111111",
    expectedUpdatedAt: now.toISOString(),
    acknowledgeHold: true,
  };
  const operation = {
    id: input.operationId,
    tenantId: "trusted-tenant",
    jobId: "job",
    action: "CREATE",
    status: "PENDING",
    updatedAt: now,
    finishedAt: null,
    calendarEventId: "private-event",
  };
  const tx = {
    calendarOperation: { findUnique: jest.fn(), updateMany: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const prisma = { $transaction: jest.fn() };
  let service: CalendarPendingReviewService;
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(context, "getRequestContext").mockReturnValue({
      tenantId: "trusted-tenant",
      userId: "trusted-owner",
      role: "owner",
    });
    jest.spyOn(Date, "now").mockReturnValue(now.getTime());
    tx.calendarOperation.findUnique.mockResolvedValue(operation);
    tx.calendarOperation.updateMany.mockResolvedValue({ count: 1 });
    tx.auditLog.create.mockResolvedValue({ id: "audit" });
    prisma.$transaction.mockImplementation(
      (fn: (value: typeof tx) => unknown) => fn(tx),
    );
    service = new CalendarPendingReviewService(
      prisma as unknown as PrismaService,
    );
  });
  afterEach(() => jest.restoreAllMocks());
  it.each(["owner", " ADMIN "])(
    "allows %s to hold only reviewed PENDING with an atomic bounded audit",
    async (role) => {
      jest.spyOn(context, "getRequestContext").mockReturnValue({
        tenantId: "trusted-tenant",
        userId: "trusted-owner",
        role,
      });
      expect(
        await service.hold({
          ...input,
          tenantId: "untrusted",
          actorId: "untrusted",
        } as typeof input),
      ).toEqual({ status: "needs_review" });
      expect(tx.calendarOperation.findUnique).toHaveBeenCalledWith({
        where: {
          id_tenantId: { id: input.operationId, tenantId: "trusted-tenant" },
        },
      });
      expect(tx.calendarOperation.updateMany).toHaveBeenCalledWith({
        where: {
          id: input.operationId,
          tenantId: "trusted-tenant",
          action: "CREATE",
          status: "PENDING",
          finishedAt: null,
          updatedAt: now,
        },
        data: {
          status: "NEEDS_REVIEW",
          updatedAt: new Date(now.getTime() + 1),
        },
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: {
          tenantId: "trusted-tenant",
          actorType: "USER",
          actorId: "trusted-owner",
          action: "appointment.pending_create_held",
          entityType: "CalendarOperation",
          entityId: input.operationId,
          metadata: {
            jobId: "job",
            reasonCode: "PENDING_CREATE_REVIEWED",
            acknowledged: true,
            reviewedUpdatedAt: input.expectedUpdatedAt,
          },
        },
      });
    },
  );
  it.each([undefined, { tenantId: "tenant" }, { userId: "owner" }])(
    "rejects missing identity %p before database access",
    async (value) => {
      jest.spyOn(context, "getRequestContext").mockReturnValue(value);
      await expect(service.hold(input)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, "dispatcher", "tech", "read_only"])(
    "rejects role %s before database access",
    async (role) => {
      jest
        .spyOn(context, "getRequestContext")
        .mockReturnValue({ tenantId: "tenant", userId: "actor", role });
      await expect(service.hold(input)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each([
    { acknowledgeHold: false },
    { expectedUpdatedAt: "invalid" },
    { expectedUpdatedAt: "2039-01-01T12:00:00Z" },
    { operationId: "invalid" },
  ])("requires explicit current review %p", async (invalid) => {
    await expect(service.hold({ ...input, ...invalid })).rejects.toThrow(
      "requires acknowledgment",
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("returns not found for missing/cross-tenant operation", async () => {
    tx.calendarOperation.findUnique.mockResolvedValue(null);
    await expect(service.hold(input)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.calendarOperation.updateMany).not.toHaveBeenCalled();
  });
  it.each([
    { action: "RESCHEDULE" },
    { action: "CANCEL" },
    ...["UNCERTAIN", "APPLIED", "NEEDS_REVIEW", "FINALIZED", "ABORTED"].map(
      (status) => ({ status }),
    ),
    { finishedAt: now },
    { updatedAt: new Date(now.getTime() + 1) },
  ])(
    "refuses non-current unattempted CREATE %p without audit or mutation",
    async (changed) => {
      tx.calendarOperation.findUnique.mockResolvedValue({
        ...operation,
        ...changed,
      });
      await expect(service.hold(input)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(tx.calendarOperation.updateMany).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    },
  );
  it("loses safely to the executor or another review without an audit", async () => {
    tx.calendarOperation.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.hold(input)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it("rolls the transaction back on audit failure and hides private diagnostics", async () => {
    tx.auditLog.create.mockRejectedValue(new Error("private database details"));
    await expect(service.hold(input)).rejects.toThrow(
      "Calendar review status is uncertain",
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it("does not retry an unknown transaction acknowledgment", async () => {
    prisma.$transaction.mockRejectedValue(new Error("private commit failure"));
    await expect(service.hold(input)).rejects.toThrow("Refresh review state");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it("remains absent from live module wiring", () => {
    expect(
      readFileSync(join(__dirname, "scheduling.module.ts"), "utf8"),
    ).not.toContain("CalendarPendingReviewService");
  });
});
