import * as context from "../common/context/request-context";
import { PrismaService } from "../prisma/prisma.service";
import { CalendarReviewStateService } from "./calendar-review-state.service";

describe("Inactive privacy-safe recovery request history", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const date = new Date("2039-01-01T12:00:00.000Z");
  const actions = [
    "appointment.applied_create_readback_requested",
    "appointment.uncertain_create_readback_requested",
  ];
  const prisma = {
    calendarOperation: { findUnique: jest.fn() },
    auditLog: { findMany: jest.fn() },
  };
  let service: CalendarReviewStateService;
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(context, "getRequestContext").mockReturnValue({
      userId: "actor",
      tenantId: "trusted-tenant",
      role: "owner",
    });
    prisma.calendarOperation.findUnique.mockResolvedValue({ id });
    prisma.auditLog.findMany.mockResolvedValue([]);
    service = new CalendarReviewStateService(
      prisma as unknown as PrismaService,
    );
  });
  afterEach(() => jest.restoreAllMocks());
  it.each(["owner", " ADMIN "])(
    "allows %s with exact scope and no private payload selection",
    async (role) => {
      jest
        .spyOn(context, "getRequestContext")
        .mockReturnValue({ userId: "actor", tenantId: "trusted-tenant", role });
      prisma.auditLog.findMany.mockResolvedValue(
        actions.map((action, i) => ({
          id: String(i),
          action,
          createdAt: date,
          actorId: "private-actor",
          traceId: "private-trace",
          metadata: { token: "private-token", customer: "private-customer" },
        })),
      );
      expect(
        await service.listRecoveryRequests({
          operationId: id,
          tenantId: "untrusted",
        } as { operationId: string }),
      ).toEqual({
        snapshotOnly: true,
        requestOnly: true,
        hasMore: false,
        items: [
          {
            requestId: "0",
            kind: "applied_create",
            requestedAt: date.toISOString(),
          },
          {
            requestId: "1",
            kind: "uncertain_create",
            requestedAt: date.toISOString(),
          },
        ],
      });
      expect(prisma.calendarOperation.findUnique).toHaveBeenCalledWith({
        where: { id_tenantId: { id, tenantId: "trusted-tenant" } },
        select: { id: true },
      });
      expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
        where: {
          tenantId: "trusted-tenant",
          entityType: "CalendarOperation",
          entityId: id,
          actorType: "USER",
          action: { in: actions },
        },
        select: { id: true, action: true, createdAt: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 101,
      });
    },
  );
  it.each([undefined, { userId: "actor" }, { tenantId: "tenant" }])(
    "refuses missing identity %p",
    async (value) => {
      jest.spyOn(context, "getRequestContext").mockReturnValue(value);
      await expect(
        service.listRecoveryRequests({ operationId: id }),
      ).rejects.toMatchObject({ status: 401 });
      expect(prisma.calendarOperation.findUnique).not.toHaveBeenCalled();
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, "dispatcher", "tech", "read_only"])(
    "refuses role %s",
    async (role) => {
      jest
        .spyOn(context, "getRequestContext")
        .mockReturnValue({ userId: "actor", tenantId: "tenant", role });
      await expect(
        service.listRecoveryRequests({ operationId: id }),
      ).rejects.toMatchObject({ status: 403 });
      expect(prisma.calendarOperation.findUnique).not.toHaveBeenCalled();
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    },
  );
  it.each(["", "invalid", " " + id])(
    "rejects invalid reference %p",
    async (operationId) => {
      await expect(
        service.listRecoveryRequests({ operationId }),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.calendarOperation.findUnique).not.toHaveBeenCalled();
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    },
  );
  it("refuses missing/cross-tenant operation before audit access", async () => {
    prisma.calendarOperation.findUnique.mockResolvedValue(null);
    await expect(
      service.listRecoveryRequests({ operationId: id }),
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });
  it.each([0, 100, 101])(
    "caps %i rows with request-only truncation",
    async (count) => {
      prisma.auditLog.findMany.mockResolvedValue(
        Array.from({ length: count }, (_, i) => ({
          id: String(i),
          action: actions[0],
          createdAt: date,
        })),
      );
      const result = await service.listRecoveryRequests({ operationId: id });
      expect(result.items).toHaveLength(Math.min(count, 100));
      expect(result.hasMore).toBe(count > 100);
      expect(result.requestOnly).toBe(true);
      expect(result.snapshotOnly).toBe(true);
    },
  );
  it.each(["lookup", "audit", "malformed"])(
    "bounds %s failure without retry",
    async (fault) => {
      if (fault === "lookup")
        prisma.calendarOperation.findUnique.mockRejectedValue(
          new Error("private-database"),
        );
      else if (fault === "audit")
        prisma.auditLog.findMany.mockRejectedValue(
          new Error("private-database"),
        );
      else
        prisma.auditLog.findMany.mockResolvedValue([
          { id, action: "private-unknown", createdAt: date },
        ]);
      await expect(
        service.listRecoveryRequests({ operationId: id }),
      ).rejects.toMatchObject({
        status: 503,
        message:
          "Calendar review state is unavailable. Refresh before taking further action.",
      });
      expect(prisma.calendarOperation.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.findMany.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );
});
