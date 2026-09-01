import { UnauthorizedException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { TechnicianLinkService } from "./technician-link.service";

describe("TechnicianLinkService", () => {
  const tenantId = "059c4950-171c-4ff5-a963-20bf6b9d59a6";
  const technicianId = "2f2ecce7-6bb1-4aaa-a946-a660c80bb6c5";
  const now = new Date("2026-08-31T18:00:00.000Z");
  const config = {
    technicianLinkSecret: "test-technician-link-secret-that-is-long-enough",
    technicianLinkTtlHours: 72,
    technicianAppBaseUrl: "https://signmons.example/app/technician",
  };

  const createHarness = () => {
    const prisma = {
      user: { findFirst: jest.fn() },
      auditLog: { create: jest.fn().mockResolvedValue({ id: "audit-link" }) },
    };
    return {
      prisma,
      service: new TechnicianLinkService(prisma as never, config as never),
    };
  };

  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it("issues an expiring technician- and tenant-scoped fragment link", async () => {
    const { prisma, service } = createHarness();
    prisma.user.findFirst.mockResolvedValue({
      id: technicianId,
      fullName: "Jordan Tech",
      role: UserRole.TECH,
    });

    const result = await service.issue({
      tenantId,
      technicianId,
      actorId: "dispatcher-1",
    });
    const token = decodeURIComponent(result.url.split("#")[1]);

    expect(result.url).toMatch(
      /^https:\/\/signmons\.example\/app\/technician#/,
    );
    expect(result.url).not.toContain("?");
    expect(service.verify(token)).toEqual({
      tenantId,
      technicianId,
      expiresAt: new Date("2026-09-03T18:00:00.000Z"),
    });
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId, id: technicianId }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "technician.link_issued",
          entityId: technicianId,
          metadata: expect.not.objectContaining({ token: expect.anything() }),
        }),
      }),
    );
  });

  it("fails closed for tampered and malformed tokens", async () => {
    const { prisma, service } = createHarness();
    prisma.user.findFirst.mockResolvedValue({
      id: technicianId,
      fullName: "Jordan Tech",
    });
    const result = await service.issue({
      tenantId,
      technicianId,
      actorId: "dispatcher-1",
    });
    const token = decodeURIComponent(result.url.split("#")[1]);

    expect(() => service.verify(`${token.slice(0, -1)}x`)).toThrow(
      UnauthorizedException,
    );
    expect(() => service.verify("not-a-token")).toThrow(UnauthorizedException);
    expect(() => service.verify(undefined)).toThrow(UnauthorizedException);
  });

  it("rejects expired links", async () => {
    const { prisma, service } = createHarness();
    prisma.user.findFirst.mockResolvedValue({
      id: technicianId,
      fullName: "Jordan Tech",
    });
    const result = await service.issue({
      tenantId,
      technicianId,
      actorId: "dispatcher-1",
      expiresInHours: 1,
    });
    const token = decodeURIComponent(result.url.split("#")[1]);
    jest.setSystemTime(new Date("2026-08-31T19:00:01.000Z"));

    expect(() => service.verify(token)).toThrow(UnauthorizedException);
  });
});
