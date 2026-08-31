import { BadRequestException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { LeadAttribution } from "../jobs/interfaces/job-repository.interface";
import type { LeadSourceReportQueryDto } from "./dto/lead-source-report-query.dto";

const MAX_REPORT_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
const BOOKED_STATUSES = new Set(["ACCEPTED", "IN_PROGRESS", "COMPLETED"]);

interface ReportCounts {
  created: number;
  booked: number;
  completed: number;
  cancelled: number;
  attributed: number;
  unattributed: number;
}

interface ReportRates {
  leadToBooking: number;
  bookedToCompleted: number;
}

interface SourceSummary {
  key: string;
  channel: "website_chat" | "unattributed";
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  totals: ReportCounts;
  rates: ReportRates;
}

interface LandingPageSummary {
  path: string;
  created: number;
  booked: number;
  completed: number;
}

export interface LeadSourceReport {
  period: { from: string; to: string };
  totals: ReportCounts;
  rates: ReportRates;
  bySource: SourceSummary[];
  topLandingPages: LandingPageSummary[];
}

interface ReportableJob {
  status: string;
  acceptedAt: Date | null;
  completedAt: Date | null;
  policySnapshot: Prisma.JsonValue;
}

@Injectable()
export class ReportingService {
  constructor(private readonly prisma: PrismaService) {}

  async getLeadSourceReport(
    tenantId: string,
    query: LeadSourceReportQueryDto,
  ): Promise<LeadSourceReport> {
    const { from, to } = this.parseRange(query);
    const jobs = await this.prisma.job.findMany({
      where: {
        tenantId,
        createdAt: { gte: from, lt: to },
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

    return this.aggregate(jobs, from, to);
  }

  private aggregate(
    jobs: ReportableJob[],
    from: Date,
    to: Date,
  ): LeadSourceReport {
    const totals = this.emptyCounts();
    const sourceGroups = new Map<string, SourceSummary>();
    const landingPages = new Map<string, LandingPageSummary>();

    for (const job of jobs) {
      const attribution = this.leadAttribution(job.policySnapshot);
      const booked = Boolean(job.acceptedAt) || BOOKED_STATUSES.has(job.status);
      const completed = Boolean(job.completedAt) || job.status === "COMPLETED";
      const cancelled = job.status === "CANCELLED";
      const counts = this.jobCounts({
        booked,
        completed,
        cancelled,
        attributed: Boolean(attribution),
      });

      this.addCounts(totals, counts);

      const source = this.sourceSummary(attribution);
      const existingSource = sourceGroups.get(source.key);
      if (existingSource) {
        this.addCounts(existingSource.totals, counts);
      } else {
        source.totals = { ...counts };
        sourceGroups.set(source.key, source);
      }

      if (attribution?.landingPage) {
        const page = landingPages.get(attribution.landingPage) ?? {
          path: attribution.landingPage,
          created: 0,
          booked: 0,
          completed: 0,
        };
        page.created += 1;
        page.booked += booked ? 1 : 0;
        page.completed += completed ? 1 : 0;
        landingPages.set(page.path, page);
      }
    }

    const bySource = [...sourceGroups.values()]
      .map((source) => ({
        ...source,
        rates: this.rates(source.totals),
      }))
      .sort(
        (left, right) =>
          right.totals.created - left.totals.created ||
          left.key.localeCompare(right.key),
      );

    const topLandingPages = [...landingPages.values()].sort(
      (left, right) =>
        right.created - left.created || left.path.localeCompare(right.path),
    );

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      totals,
      rates: this.rates(totals),
      bySource,
      topLandingPages,
    };
  }

  private parseRange(query: LeadSourceReportQueryDto) {
    const from = new Date(query.from);
    const to = new Date(query.to);
    const duration = to.getTime() - from.getTime();
    if (
      !Number.isFinite(from.getTime()) ||
      !Number.isFinite(to.getTime()) ||
      duration <= 0 ||
      duration > MAX_REPORT_RANGE_MS
    ) {
      throw new BadRequestException(
        "Report range must be positive and no longer than 366 days.",
      );
    }
    return { from, to };
  }

  private leadAttribution(
    snapshot: Prisma.JsonValue,
  ): LeadAttribution | undefined {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return undefined;
    }
    const value = (snapshot as Record<string, unknown>).leadAttribution;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const input = value as Record<string, unknown>;
    if (input.channel !== "website_chat") return undefined;

    const path = (candidate: unknown) =>
      typeof candidate === "string" &&
      candidate.length <= 200 &&
      /^\/[A-Za-z0-9/_-]*$/.test(candidate)
        ? candidate
        : undefined;
    const text = (candidate: unknown, limit: number) =>
      typeof candidate === "string" && candidate.trim().length
        ? candidate.trim().slice(0, limit)
        : undefined;

    return {
      channel: "website_chat",
      landingPage: path(input.landingPage),
      sourcePage: path(input.sourcePage),
      referrerHost: text(input.referrerHost, 253),
      utmSource: text(input.utmSource, 100),
      utmMedium: text(input.utmMedium, 100),
      utmCampaign: text(input.utmCampaign, 160),
    };
  }

  private sourceSummary(attribution?: LeadAttribution): SourceSummary {
    if (!attribution) {
      return {
        key: "unattributed",
        channel: "unattributed",
        totals: this.emptyCounts(),
        rates: this.rates(this.emptyCounts()),
      };
    }

    const utmSource = attribution.utmSource || "direct";
    const utmMedium = attribution.utmMedium || "none";
    const utmCampaign = attribution.utmCampaign || "none";
    return {
      key: [attribution.channel, utmSource, utmMedium, utmCampaign].join("|"),
      channel: attribution.channel,
      ...(attribution.utmSource ? { utmSource: attribution.utmSource } : {}),
      ...(attribution.utmMedium ? { utmMedium: attribution.utmMedium } : {}),
      ...(attribution.utmCampaign
        ? { utmCampaign: attribution.utmCampaign }
        : {}),
      totals: this.emptyCounts(),
      rates: this.rates(this.emptyCounts()),
    };
  }

  private jobCounts(input: {
    booked: boolean;
    completed: boolean;
    cancelled: boolean;
    attributed: boolean;
  }): ReportCounts {
    return {
      created: 1,
      booked: input.booked ? 1 : 0,
      completed: input.completed ? 1 : 0,
      cancelled: input.cancelled ? 1 : 0,
      attributed: input.attributed ? 1 : 0,
      unattributed: input.attributed ? 0 : 1,
    };
  }

  private emptyCounts(): ReportCounts {
    return {
      created: 0,
      booked: 0,
      completed: 0,
      cancelled: 0,
      attributed: 0,
      unattributed: 0,
    };
  }

  private addCounts(target: ReportCounts, source: ReportCounts): void {
    target.created += source.created;
    target.booked += source.booked;
    target.completed += source.completed;
    target.cancelled += source.cancelled;
    target.attributed += source.attributed;
    target.unattributed += source.unattributed;
  }

  private rates(counts: ReportCounts): ReportRates {
    return {
      leadToBooking: this.ratio(counts.booked, counts.created),
      bookedToCompleted: this.ratio(counts.completed, counts.booked),
    };
  }

  private ratio(numerator: number, denominator: number): number {
    return denominator > 0
      ? Math.round((numerator / denominator) * 10_000) / 10_000
      : 0;
  }
}
