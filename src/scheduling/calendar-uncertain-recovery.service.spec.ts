import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as context from "../common/context/request-context";
import { PrismaService } from "../prisma/prisma.service";
import { CalendarCreateReconciliationService } from "./calendar-create-reconciliation.service";
import { CalendarUncertainRecoveryService } from "./calendar-uncertain-recovery.service";

describe("Inactive reviewed UNCERTAIN CREATE recovery", () => {
  const now = new Date("2039-01-01T12:00:00.000Z");
  const input = {
    operationId: "11111111-1111-4111-8111-111111111111",
    expectedUpdatedAt: now.toISOString(),
    acknowledgeReadback: true,
  };
  const operation = {
    id: input.operationId,
    jobId: "job",
    tenantId: "trusted-tenant",
    action: "CREATE",
    status: "UNCERTAIN",
    finishedAt: null,
    updatedAt: now,
  };
  const tx = {
    calendarOperation: { findUnique: jest.fn(), updateMany: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const prisma = { $transaction: jest.fn() },
    reconciliation = { reconcile: jest.fn() };
  let service: CalendarUncertainRecoveryService;
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(context, "getRequestContext").mockReturnValue({
      userId: "trusted-user",
      tenantId: "trusted-tenant",
      role: "owner",
    });
    jest.spyOn(Date, "now").mockReturnValue(now.getTime() + 10_000);
    tx.calendarOperation.findUnique.mockResolvedValue(operation);
    tx.calendarOperation.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(
      (fn: (value: typeof tx) => unknown) => fn(tx),
    );
    reconciliation.reconcile.mockResolvedValue({
      status: "finalized",
      privateData: "never-return",
    });
    service = new CalendarUncertainRecoveryService(
      prisma as unknown as PrismaService,
      reconciliation as unknown as CalendarCreateReconciliationService,
    );
  });
  afterEach(() => jest.restoreAllMocks());
  it.each([0, 9_999])(
    "refuses legacy admission %i ms into its active wait without audit",
    async (elapsed) => {
      jest.mocked(Date.now).mockReturnValue(now.getTime() + elapsed);
      await expect(service.recover(input)).rejects.toMatchObject({
        status: 409,
      });
      expect(tx.calendarOperation.updateMany).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
      expect(reconciliation.reconcile).not.toHaveBeenCalled();
    },
  );
  it.each([new Date(now.getTime() + 10_001), new Date("invalid")])(
    "fails closed on persisted boundary %p",
    async (readbackNotBefore) => {
      tx.calendarOperation.findUnique.mockResolvedValue({
        ...operation,
        readbackNotBefore,
      });
      await expect(service.recover(input)).rejects.toMatchObject({
        status: 409,
      });
      expect(tx.auditLog.create).not.toHaveBeenCalled();
      expect(reconciliation.reconcile).not.toHaveBeenCalled();
    },
  );
  it("preserves an elapsed persisted boundary even when the reviewed version is recent", async () => {
    const notBefore = new Date(now.getTime() - 1000);
    tx.calendarOperation.findUnique.mockResolvedValue({
      ...operation,
      readbackNotBefore: notBefore,
    });
    jest.mocked(Date.now).mockReturnValue(now.getTime());
    expect(await service.recover(input)).toEqual({ status: "finalized" });
    expect(tx.calendarOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          updatedAt: new Date(now.getTime() + 1),
          readbackNotBefore: notBefore,
        },
      }),
    );
  });
  it.each(["owner", " ADMIN "])(
    "audits %s admission atomically then uses the acknowledged version",
    async (role) => {
      jest.spyOn(context, "getRequestContext").mockReturnValue({
        userId: "trusted-user",
        tenantId: "trusted-tenant",
        role,
      });
      expect(
        await service.recover({
          ...input,
          tenantId: "untrusted",
          actorId: "untrusted",
        } as typeof input),
      ).toEqual({ status: "finalized" });
      expect(tx.calendarOperation.findUnique).toHaveBeenCalledWith({
        where: {
          id_tenantId: { id: input.operationId, tenantId: "trusted-tenant" },
        },
      });
      const version = new Date(now.getTime() + 10_000);
      expect(tx.calendarOperation.updateMany).toHaveBeenCalledWith({
        where: {
          id: input.operationId,
          tenantId: "trusted-tenant",
          action: "CREATE",
          status: "UNCERTAIN",
          finishedAt: null,
          updatedAt: now,
        },
        data: { updatedAt: version, readbackNotBefore: version },
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: {
          tenantId: "trusted-tenant",
          actorType: "USER",
          actorId: "trusted-user",
          action: "appointment.uncertain_create_readback_requested",
          entityType: "CalendarOperation",
          entityId: input.operationId,
          metadata: {
            jobId: "job",
            reasonCode: "UNCERTAIN_CREATE_REVIEWED",
            acknowledged: true,
            reviewedUpdatedAt: input.expectedUpdatedAt,
            admittedUpdatedAt: version.toISOString(),
            readbackNotBefore: version.toISOString(),
          },
        },
      });
      expect(reconciliation.reconcile).toHaveBeenCalledWith({
        tenantId: "trusted-tenant",
        operationId: input.operationId,
        expectedUpdatedAt: version,
      });
      expect(tx.auditLog.create.mock.invocationCallOrder[0]).toBeLessThan(
        reconciliation.reconcile.mock.invocationCallOrder[0],
      );
    },
  );
  it.each([undefined, { tenantId: "tenant" }, { userId: "actor" }])(
    "requires identity %p before DB",
    async (value) => {
      jest.spyOn(context, "getRequestContext").mockReturnValue(value);
      await expect(service.recover(input)).rejects.toMatchObject({
        status: 401,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(reconciliation.reconcile).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, "dispatcher", "tech", "read_only"])(
    "refuses role %s before DB",
    async (role) => {
      jest
        .spyOn(context, "getRequestContext")
        .mockReturnValue({ userId: "actor", tenantId: "tenant", role });
      await expect(service.recover(input)).rejects.toMatchObject({
        status: 403,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(reconciliation.reconcile).not.toHaveBeenCalled();
    },
  );
  it.each([
    { acknowledgeReadback: false },
    { operationId: "invalid" },
    { expectedUpdatedAt: "invalid" },
    { expectedUpdatedAt: "2039-01-01T12:00:00Z" },
  ])("requires exact review %p", async (invalid) => {
    await expect(
      service.recover({ ...input, ...invalid }),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(reconciliation.reconcile).not.toHaveBeenCalled();
  });
  it("uniformly refuses missing/cross-tenant operations", async () => {
    tx.calendarOperation.findUnique.mockResolvedValue(null);
    await expect(service.recover(input)).rejects.toMatchObject({ status: 404 });
    expect(reconciliation.reconcile).not.toHaveBeenCalled();
  });
  it.each([
    { action: "RESCHEDULE" },
    { action: "CANCEL" },
    ...["PENDING", "APPLIED", "NEEDS_REVIEW", "FINALIZED", "ABORTED"].map(
      (status) => ({ status }),
    ),
    { finishedAt: now },
    { updatedAt: new Date(now.getTime() + 1) },
  ])("refuses state/version %p without audit or recovery", async (changed) => {
    tx.calendarOperation.findUnique.mockResolvedValue({
      ...operation,
      ...changed,
    });
    await expect(service.recover(input)).rejects.toMatchObject({ status: 409 });
    expect(tx.calendarOperation.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(reconciliation.reconcile).not.toHaveBeenCalled();
  });
  it("refuses a lost CAS without audit or reconciliation", async () => {
    tx.calendarOperation.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.recover(input)).rejects.toMatchObject({ status: 409 });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(reconciliation.reconcile).not.toHaveBeenCalled();
  });
  it.each(["audit", "transaction"])(
    "does not recover after unknown %s acknowledgment",
    async (fault) => {
      if (fault === "audit")
        tx.auditLog.create.mockRejectedValue(new Error("private-diagnostic"));
      else
        prisma.$transaction.mockRejectedValue(new Error("private-diagnostic"));
      await expect(service.recover(input)).rejects.toMatchObject({
        status: 503,
        message:
          "Calendar recovery outcome is uncertain. Refresh review state before taking further action.",
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(reconciliation.reconcile).not.toHaveBeenCalled();
    },
  );
  it.each(["finalized", "already_finalized", "pending", "needs_review"])(
    "returns only internal %s status",
    async (status) => {
      reconciliation.reconcile.mockResolvedValue({
        status,
        privateData: "never-return",
      });
      expect(await service.recover(input)).toEqual({ status });
    },
  );
  it.each(["throw", "unknown"])(
    "bounds %s recovery outcome without retry or compensation",
    async (fault) => {
      if (fault === "throw")
        reconciliation.reconcile.mockRejectedValue(new Error("private"));
      else
        reconciliation.reconcile.mockResolvedValue({
          status: "unexpected",
          privateData: "private",
        });
      await expect(service.recover(input)).rejects.toMatchObject({
        status: 503,
      });
      expect(reconciliation.reconcile).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    },
  );
  it("remains absent from module wiring", () => {
    expect(
      readFileSync(join(__dirname, "scheduling.module.ts"), "utf8"),
    ).not.toContain("CalendarUncertainRecoveryService");
  });
});
