import { UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TechnicianLinkService } from "./technician-link.service";
import {
  TechnicianNotificationsService,
  TECHNICIAN_NOTIFICATION_ACTIONS,
} from "./technician-notifications.service";

describe("TechnicianNotificationsService", () => {
  const access = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    technicianId: "22222222-2222-4222-8222-222222222222",
    expiresAt: new Date("2039-01-01"),
  };
  const user = { findFirst: jest.fn() },
    query = jest.fn(),
    verify = jest.fn();
  let service: TechnicianNotificationsService;
  beforeEach(() => {
    jest.clearAllMocks();
    user.findFirst.mockResolvedValue({ id: access.technicianId });
    query.mockResolvedValue([]);
    verify.mockReturnValue(access);
    service = new TechnicianNotificationsService(
      { user, $queryRaw: query } as unknown as PrismaService,
      { verify } as unknown as TechnicianLinkService,
    );
  });
  it("validates the link before database access", async () => {
    verify.mockImplementation(() => {
      throw new UnauthorizedException();
    });
    await expect(service.list("tampered")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(user.findFirst).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it("requires an active technician in the signed tenant before reading events", async () => {
    user.findFirst.mockResolvedValue(null);
    await expect(service.list("fixture")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(user.findFirst).toHaveBeenCalledWith({
      where: {
        id: access.technicianId,
        tenantId: access.tenantId,
        role: "TECH",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    expect(query).not.toHaveBeenCalled();
  });
  it("joins current assignment, tenant, active role and deletion checks with allowlisted audit reads", async () => {
    const result = await service.list("fixture");
    const calls = query.mock.calls as unknown as [
      { sql: string; values: unknown[] },
    ][];
    const sql = calls[0][0];
    for (const text of [
      'JOIN "Job"',
      'JOIN "User"',
      'j."assignedUserTenantId"',
      'j."deletedAt" IS NULL',
      "a.\"entityType\" = 'Job'",
      "u.\"role\" = 'TECH'",
      "u.\"status\" = 'ACTIVE'",
      'ORDER BY a."createdAt" DESC, a."id" DESC',
      "LIMIT 101",
    ])
      expect(sql.sql).toContain(text);
    expect(sql.values).toContain(access.tenantId);
    expect(sql.values).toContain(access.technicianId);
    for (const action of TECHNICIAN_NOTIFICATION_ACTIONS)
      expect(sql.values).toContain(action);
    expect(sql.sql).not.toContain(access.tenantId);
    expect(sql.sql).not.toContain("metadata");
    expect(result).toMatchObject({
      snapshot: true,
      lookbackDays: 90,
      limit: 100,
      hasMore: false,
      items: [],
    });
  });
  it("projects only event references, fixed action and time", async () => {
    query.mockResolvedValue([
      {
        id: "event",
        jobId: "job",
        action: "job.assigned",
        createdAt: new Date("2026-09-09T12:00:00Z"),
        metadata: { secret: "private" },
        actorId: "private",
      },
    ]);
    expect((await service.list("fixture")).items).toEqual([
      {
        id: "event",
        jobId: "job",
        action: "job.assigned",
        occurredAt: "2026-09-09T12:00:00.000Z",
      },
    ]);
  });
  it("caps at 100 with truthful hasMore", async () => {
    query.mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => ({
        id: String(i),
        jobId: "job",
        action: "job.assigned",
        createdAt: new Date(),
      })),
    );
    const result = await service.list("fixture");
    expect(result.items).toHaveLength(100);
    expect(result.hasMore).toBe(true);
  });
  it("does not replace a database failure with an empty success", async () => {
    query.mockRejectedValue(new Error("private database failure"));
    await expect(service.list("fixture")).rejects.toThrow();
  });
});
