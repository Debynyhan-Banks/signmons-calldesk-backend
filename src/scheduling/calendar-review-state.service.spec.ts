import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as context from "../common/context/request-context";
import { PrismaService } from "../prisma/prisma.service";
import { CalendarReviewStateService } from "./calendar-review-state.service";

describe("Inactive privacy-safe Calendar review state", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const now = new Date("2039-01-01T12:00:00.001Z");
  const row = {
    id,
    jobId: id,
    action: "CREATE",
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    calendarId: "private-target",
    calendarEventId: "private-event",
    desiredTimeText: "private-customer-text",
    previousTimeText: "private-old-text",
    tenantId: "private-tenant",
    claimedUpdatedAt: now,
    job: { managementToken: "private-token", payment: "private-payment" },
  };
  const select = {
    id: true,
    jobId: true,
    action: true,
    status: true,
    createdAt: true,
    updatedAt: true,
    finishedAt: true,
  };
  const prisma = {
    calendarOperation: { findMany: jest.fn(), findUnique: jest.fn() },
  };
  let service: CalendarReviewStateService;
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(context, "getRequestContext").mockReturnValue({
      userId: "trusted-user",
      tenantId: "trusted-tenant",
      role: "owner",
    });
    prisma.calendarOperation.findMany.mockResolvedValue([row]);
    prisma.calendarOperation.findUnique.mockResolvedValue(row);
    service = new CalendarReviewStateService(
      prisma as unknown as PrismaService,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(["owner", " ADMIN "])(
    "allows %s with trusted tenant and explicit allowlist",
    async (role) => {
      jest.spyOn(context, "getRequestContext").mockReturnValue({
        userId: "trusted-user",
        tenantId: "trusted-tenant",
        role,
      });
      const list = await service.listForJob({
        jobId: id,
        tenantId: "untrusted",
      } as { jobId: string });
      const detail = await service.read({
        operationId: id,
        tenantId: "untrusted",
      } as { operationId: string });
      expect(prisma.calendarOperation.findMany).toHaveBeenCalledWith({
        where: { tenantId: "trusted-tenant", jobId: id },
        select,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 101,
      });
      expect(prisma.calendarOperation.findUnique).toHaveBeenCalledWith({
        where: { id_tenantId: { id, tenantId: "trusted-tenant" } },
        select,
      });
      expect(list).toEqual({
        snapshotOnly: true,
        items: [detail],
        hasMore: false,
      });
      expect(detail).toEqual({
        snapshotOnly: true,
        operationId: id,
        jobId: id,
        action: "CREATE",
        status: "PENDING",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        finishedAt: null,
        pendingHoldReviewCandidate: true,
      });
      expect(JSON.stringify(list)).not.toContain("private-");
    },
  );
  it.each([
    undefined,
    { tenantId: "tenant" },
    { userId: "actor" },
    { userId: " ", tenantId: "tenant" },
  ])("rejects missing identity %p before any query", async (value) => {
    jest.spyOn(context, "getRequestContext").mockReturnValue(value);
    await expect(service.listForJob({ jobId: id })).rejects.toMatchObject({
      status: 401,
    });
    await expect(service.read({ operationId: id })).rejects.toMatchObject({
      status: 401,
    });
    expect(prisma.calendarOperation.findMany).not.toHaveBeenCalled();
    expect(prisma.calendarOperation.findUnique).not.toHaveBeenCalled();
  });
  it.each([undefined, "dispatcher", "tech", "read_only"])(
    "rejects role %s before any query",
    async (role) => {
      jest
        .spyOn(context, "getRequestContext")
        .mockReturnValue({ userId: "actor", tenantId: "tenant", role });
      await expect(service.listForJob({ jobId: id })).rejects.toMatchObject({
        status: 403,
      });
      await expect(service.read({ operationId: id })).rejects.toMatchObject({
        status: 403,
      });
      expect(prisma.calendarOperation.findMany).not.toHaveBeenCalled();
      expect(prisma.calendarOperation.findUnique).not.toHaveBeenCalled();
    },
  );
  it.each(["", "invalid", " " + id])(
    "rejects invalid reference %p without querying",
    async (value) => {
      await expect(service.listForJob({ jobId: value })).rejects.toMatchObject({
        status: 400,
      });
      await expect(service.read({ operationId: value })).rejects.toMatchObject({
        status: 400,
      });
      expect(prisma.calendarOperation.findMany).not.toHaveBeenCalled();
      expect(prisma.calendarOperation.findUnique).not.toHaveBeenCalled();
    },
  );
  it("returns an empty snapshot, never proof of booking or absence of provider work", async () => {
    prisma.calendarOperation.findMany.mockResolvedValue([]);
    expect(await service.listForJob({ jobId: id })).toEqual({
      snapshotOnly: true,
      items: [],
      hasMore: false,
    });
  });
  it.each([100, 101])(
    "caps %i rows at 100 and identifies truncation",
    async (count) => {
      prisma.calendarOperation.findMany.mockResolvedValue(
        Array.from({ length: count }, (_, i) => ({ ...row, id: String(i) })),
      );
      const result = await service.listForJob({ jobId: id });
      expect(result.items).toHaveLength(100);
      expect(result.hasMore).toBe(count > 100);
      expect(result.items[99].operationId).toBe("99");
    },
  );
  it("makes missing and cross-tenant detail indistinguishable", async () => {
    prisma.calendarOperation.findUnique.mockResolvedValue(null);
    await expect(service.read({ operationId: id })).rejects.toMatchObject({
      status: 404,
    });
  });
  it.each([
    { action: "RESCHEDULE" },
    { action: "CANCEL" },
    ...["UNCERTAIN", "APPLIED", "NEEDS_REVIEW", "FINALIZED", "ABORTED"].map(
      (status) => ({ status }),
    ),
    { finishedAt: now },
  ])("exposes history but no hold candidate for %p", async (change) => {
    prisma.calendarOperation.findUnique.mockResolvedValue({
      ...row,
      ...change,
    });
    const result = await service.read({ operationId: id });
    expect(result.pendingHoldReviewCandidate).toBe(false);
    expect(result.snapshotOnly).toBe(true);
    expect(result.finishedAt).toBe(
      change.finishedAt ? now.toISOString() : null,
    );
  });
  it("refreshes state on each read rather than caching prior candidates", async () => {
    prisma.calendarOperation.findUnique
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({
        ...row,
        status: "NEEDS_REVIEW",
        updatedAt: new Date(now.getTime() + 1),
      });
    expect(
      (await service.read({ operationId: id })).pendingHoldReviewCandidate,
    ).toBe(true);
    expect(await service.read({ operationId: id })).toMatchObject({
      status: "NEEDS_REVIEW",
      updatedAt: new Date(now.getTime() + 1).toISOString(),
      pendingHoldReviewCandidate: false,
    });
  });
  it("bounds query failures and never retries or returns cached results", async () => {
    prisma.calendarOperation.findMany.mockRejectedValue(
      new Error("private-database"),
    );
    prisma.calendarOperation.findUnique.mockRejectedValue(
      new Error("private-database"),
    );
    for (const promise of [
      service.listForJob({ jobId: id }),
      service.read({ operationId: id }),
    ])
      await expect(promise).rejects.toMatchObject({
        status: 503,
        message:
          "Calendar review state is unavailable. Refresh before taking further action.",
      });
    expect(prisma.calendarOperation.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.calendarOperation.findUnique).toHaveBeenCalledTimes(1);
  });
  it("does not serialize malformed dates or private records as a fallback", async () => {
    prisma.calendarOperation.findUnique.mockResolvedValue({
      ...row,
      updatedAt: new Date("invalid"),
    });
    await expect(service.read({ operationId: id })).rejects.toMatchObject({
      status: 503,
    });
  });
  it("remains absent from live module wiring", () => {
    expect(
      readFileSync(join(__dirname, "scheduling.module.ts"), "utf8"),
    ).not.toContain("CalendarReviewStateService");
  });
});
