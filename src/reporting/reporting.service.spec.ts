import { BadRequestException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import { ReportingService } from "./reporting.service";

describe("ReportingService", () => {
  const tenantId = "059c4950-171c-4ff9-a963-20bf6b9d59a6";
  const query = {
    from: "2026-08-01T00:00:00-04:00",
    to: "2026-09-01T00:00:00-04:00",
  };

  const createService = (jobs: unknown[]) => {
    const findMany = jest.fn().mockResolvedValue(jobs);
    const prisma = { job: { findMany } } as unknown as PrismaService;
    return { service: new ReportingService(prisma), findMany };
  };

  it("returns tenant-scoped, PII-free source and landing-page totals", async () => {
    const { service, findMany } = createService([
      {
        status: "ACCEPTED",
        acceptedAt: new Date("2026-08-30T23:39:00Z"),
        completedAt: null,
        policySnapshot: {
          leadAttribution: {
            channel: "website_chat",
            landingPage: "/",
            sourcePage: "/",
            utmSource: "acceptance_test",
            utmMedium: "website",
            utmCampaign: "job_attribution",
          },
        },
      },
      {
        status: "COMPLETED",
        acceptedAt: new Date("2026-08-12T15:00:00Z"),
        completedAt: new Date("2026-08-12T18:00:00Z"),
        policySnapshot: {},
      },
      {
        status: "CANCELLED",
        acceptedAt: null,
        completedAt: null,
        policySnapshot: {
          leadAttribution: {
            channel: "website_chat",
            landingPage: "/services/boiler-service",
            utmSource: "google",
            utmMedium: "organic",
          },
        },
      },
    ]);

    const report = await service.getLeadSourceReport(tenantId, query);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId,
        createdAt: {
          gte: new Date("2026-08-01T04:00:00.000Z"),
          lt: new Date("2026-09-01T04:00:00.000Z"),
        },
        deletedAt: null,
      },
      select: {
        status: true,
        acceptedAt: true,
        completedAt: true,
        policySnapshot: true,
      },
      orderBy: { createdAt: "asc" },
    });
    expect(report.totals).toEqual({
      created: 3,
      booked: 2,
      completed: 1,
      cancelled: 1,
      attributed: 2,
      unattributed: 1,
    });
    expect(report.rates).toEqual({
      leadToBooking: 0.6667,
      bookedToCompleted: 0.5,
    });
    expect(report.bySource).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "website_chat|acceptance_test|website|job_attribution",
          totals: expect.objectContaining({ created: 1, booked: 1 }),
        }),
        expect.objectContaining({
          key: "unattributed",
          totals: expect.objectContaining({
            created: 1,
            completed: 1,
            unattributed: 1,
          }),
        }),
      ]),
    );
    expect(report.topLandingPages).toEqual([
      { path: "/", created: 1, booked: 1, completed: 0 },
      {
        path: "/services/boiler-service",
        created: 1,
        booked: 0,
        completed: 0,
      },
    ]);
    expect(JSON.stringify(report)).not.toMatch(
      /customer|phone|address|description|calendarEventId/i,
    );
  });

  it("counts cancelled jobs with accepted lineage as booked", async () => {
    const { service } = createService([
      {
        status: "CANCELLED",
        acceptedAt: new Date("2026-08-20T13:00:00Z"),
        completedAt: null,
        policySnapshot: {},
      },
    ]);

    const report = await service.getLeadSourceReport(tenantId, query);
    expect(report.totals).toEqual(
      expect.objectContaining({ created: 1, booked: 1, cancelled: 1 }),
    );
  });

  it.each([
    {
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-01T00:00:00Z",
    },
    {
      from: "2026-09-02T00:00:00Z",
      to: "2026-09-01T00:00:00Z",
    },
    {
      from: "2025-01-01T00:00:00Z",
      to: "2026-09-01T00:00:00Z",
    },
  ])("rejects an invalid or unbounded range", async (invalidQuery) => {
    const { service, findMany } = createService([]);
    await expect(
      service.getLeadSourceReport(tenantId, invalidQuery),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });
});
