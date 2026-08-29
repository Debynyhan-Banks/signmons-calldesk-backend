import { randomUUID } from "crypto";
import { BadRequestException, Injectable } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import type { Prisma } from "@prisma/client";
import { JobStatus, JobUrgency, PreferredWindowLabel } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SanitizationService } from "../sanitization/sanitization.service";
import { CreateJobPayloadDto } from "./dto/create-job-payload.dto";
import { JobNotificationService } from "./job-notification.service";
import {
  CreateJobFromToolCallRequest,
  CreateJobPayload,
  IJobRepository,
  JobRecord,
} from "./interfaces/job-repository.interface";

@Injectable()
export class JobsService implements IJobRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sanitizationService: SanitizationService,
    private readonly jobNotificationService: JobNotificationService,
  ) {}

  async createJobFromToolCall(
    request: CreateJobFromToolCallRequest,
  ): Promise<JobRecord> {
    const tenantId = this.sanitizeTenantId(request.tenantId);
    const existingJob = await this.findExistingJobForSession(
      tenantId,
      request.sessionId,
    );
    if (existingJob) {
      return this.mapJob(existingJob);
    }
    const { payload: normalizedPayload } = this.parseAndNormalizePayload(
      request.rawArgs,
    );

    const customer = await this.prisma.customer.upsert({
      where: {
        tenantId_phone: {
          tenantId,
          phone: normalizedPayload.phone,
        },
      },
      update: {
        fullName: normalizedPayload.customerName,
        updatedAt: new Date(),
      },
      create: {
        id: randomUUID(),
        tenantId,
        phone: normalizedPayload.phone,
        fullName: normalizedPayload.customerName,
        updatedAt: new Date(),
      },
    });

    const serviceCategory = await this.findOrCreateServiceCategory(
      tenantId,
      normalizedPayload.issueCategory,
    );

    const propertyAddress = await this.prisma.propertyAddress.create({
      data: {
        id: randomUUID(),
        tenantId,
        customerId: customer.id,
        customerTenantId: tenantId,
        googlePlaceId: randomUUID(),
        formattedAddress: normalizedPayload.address ?? "Unknown address",
        addressComponents: {},
        latitude: 0,
        longitude: 0,
        updatedAt: new Date(),
      },
    });

    const job = await this.prisma.job.create({
      data: {
        id: randomUUID(),
        tenantId,
        customerId: customer.id,
        customerTenantId: tenantId,
        propertyAddressId: propertyAddress.id,
        propertyAddressTenantId: tenantId,
        serviceCategoryId: serviceCategory.id,
        serviceCategoryTenantId: tenantId,
        status: JobStatus.CREATED,
        urgency: this.mapUrgency(normalizedPayload.urgency),
        description: normalizedPayload.description ?? null,
        preferredWindowLabel: this.inferPreferredWindow(
          normalizedPayload.preferredTime,
        ),
        preferredTimeText: normalizedPayload.preferredTime ?? null,
        pricingSnapshot: {},
        policySnapshot: {},
      },
      include: {
        customer: true,
        propertyAddress: true,
        serviceCategory: true,
      },
    });

    const jobRecord = this.mapJob(job);
    await this.jobNotificationService.notifyJobCreated(jobRecord);
    return jobRecord;
  }

  async listJobs(tenantId: string): Promise<JobRecord[]> {
    const sanitizedTenantId = this.sanitizeTenantId(tenantId);
    const jobs = await this.prisma.job.findMany({
      where: { tenantId: sanitizedTenantId },
      orderBy: { createdAt: "desc" },
      include: {
        customer: true,
        propertyAddress: true,
        serviceCategory: true,
      },
    });
    return jobs.map((job) => this.mapJob(job));
  }

  private parseAndNormalizePayload(rawArgs?: string): {
    payload: CreateJobPayload;
    audit: {
      rawArgs: string;
      normalizedArgs: CreateJobPayload;
      validationErrors?: unknown;
    };
  } {
    const raw = this.parseRawArgs(rawArgs);
    const normalized = this.normalizePayload(raw);
    const extraKeys = this.findUnexpectedKeys(raw);
    const errors = this.validatePayload(normalized);
    const audit = {
      rawArgs: rawArgs ?? "",
      normalizedArgs: normalized,
      validationErrors:
        errors.length || extraKeys.length ? { errors, extraKeys } : undefined,
    };
    if (extraKeys.length) {
      throw new BadRequestException(
        this.buildValidationError(
          "Job payload contains unexpected fields.",
          audit,
        ),
      );
    }
    if (errors.length) {
      throw new BadRequestException(
        this.buildValidationError("Job payload validation failed.", audit),
      );
    }
    return { payload: normalized, audit };
  }

  private findUnexpectedKeys(payload: Record<string, unknown>): string[] {
    const allowed = new Set([
      "customerName",
      "phone",
      "address",
      "issueCategory",
      "urgency",
      "description",
      "preferredTime",
    ]);
    return Object.keys(payload).filter((key) => !allowed.has(key));
  }

  private parseRawArgs(rawArgs?: string): Record<string, unknown> {
    if (!rawArgs?.trim()) {
      throw new BadRequestException("Job payload missing.");
    }
    try {
      const parsed = JSON.parse(rawArgs) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object") {
        throw new BadRequestException("Job payload must be an object.");
      }
      return parsed;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException("Invalid job creation payload.");
    }
  }

  private sanitizeTenantId(tenantId: string): string {
    const sanitized = this.sanitizationService.sanitizeIdentifier(tenantId);
    if (!sanitized) {
      throw new BadRequestException("Invalid tenant identifier.");
    }
    return sanitized;
  }

  private normalizePayload(payload: Record<string, unknown>): CreateJobPayload {
    const normalizedIssueCategory = this.normalizeIssueCategory(
      payload.issueCategory,
    );
    const normalizedUrgency = this.normalizeUrgency(payload.urgency);
    return {
      customerName: this.normalizeRequiredText(payload.customerName),
      phone: this.normalizePhone(payload.phone),
      address: this.normalizeOptionalText(payload.address),
      issueCategory: normalizedIssueCategory,
      urgency: normalizedUrgency,
      description: this.normalizeOptionalText(payload.description),
      preferredTime: this.normalizeOptionalText(payload.preferredTime),
    };
  }

  private validatePayload(payload: CreateJobPayload) {
    const dto = plainToInstance(CreateJobPayloadDto, payload);
    return validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    });
  }

  private buildValidationError(
    message: string,
    audit: { rawArgs: string; normalizedArgs: CreateJobPayload },
  ) {
    const includeAudit = process.env.NODE_ENV !== "production";
    return includeAudit ? { message, audit } : { message };
  }

  private mapJob(
    job: Prisma.JobGetPayload<{
      include: {
        customer: true;
        propertyAddress: true;
        serviceCategory: true;
      };
    }>,
  ): JobRecord {
    return {
      id: job.id,
      tenantId: job.tenantId,
      customerName: job.customer.fullName,
      phone: job.customer.phone,
      address: job.propertyAddress.formattedAddress,
      issueCategory: job.serviceCategory.name,
      urgency: job.urgency,
      description: job.description ?? undefined,
      preferredTime: job.preferredWindowLabel ?? undefined,
      preferredTimeText: job.preferredTimeText ?? undefined,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private async findExistingJobForSession(
    tenantId: string,
    sessionId: string,
  ): Promise<Prisma.JobGetPayload<{
    include: {
      customer: true;
      propertyAddress: true;
      serviceCategory: true;
    };
  }> | null> {
    const logs = await this.prisma.communicationContent.findMany({
      where: {
        tenantId,
        payload: {
          path: ["sessionId"],
          equals: sessionId,
        },
      },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { payload: true },
    });

    const jobId = logs
      .map((log) => this.extractJobId(log.payload))
      .find((value): value is string => Boolean(value));

    if (!jobId) {
      return null;
    }

    return this.prisma.job.findUnique({
      where: { id: jobId },
      include: {
        customer: true,
        propertyAddress: true,
        serviceCategory: true,
      },
    });
  }

  private extractJobId(payload: Prisma.JsonValue): string | null {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const record = payload as Record<string, unknown>;
    return typeof record.jobId === "string" ? record.jobId : null;
  }

  private async findOrCreateServiceCategory(tenantId: string, name: string) {
    const existing = await this.prisma.serviceCategory.findFirst({
      where: {
        tenantId,
        name,
      },
    });
    if (existing) {
      return existing;
    }

    return this.prisma.serviceCategory.create({
      data: {
        id: randomUUID(),
        tenantId,
        name,
        updatedAt: new Date(),
      },
    });
  }

  private normalizeRequiredText(value: unknown): string {
    if (typeof value !== "string") return "";
    return this.sanitizationService.sanitizeText(value);
  }

  private normalizeOptionalText(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const sanitized = this.sanitizationService.sanitizeText(value);
    return sanitized.length ? sanitized : undefined;
  }

  private normalizePhone(value: unknown): string {
    if (typeof value !== "string") return "";
    const digits = value.replace(/\D/g, "");
    if (digits.length === 10) {
      return `+1${digits}`;
    }
    if (digits.length === 11 && digits.startsWith("1")) {
      return `+${digits}`;
    }
    if (digits.length >= 8 && digits.length <= 15) {
      return `+${digits}`;
    }
    return "";
  }

  private normalizeIssueCategory(
    value: unknown,
  ): CreateJobPayload["issueCategory"] {
    if (typeof value !== "string") return "" as never;
    const normalized = this.sanitizationService
      .normalizeWhitespace(value)
      .toUpperCase()
      .replace(/[^A-Z\s]/g, "")
      .trim();
    const mapped = {
      HEAT: "HEATING",
      HEATER: "HEATING",
      FURNACE: "HEATING",
      HVAC: "HEATING",
      AC: "COOLING",
      "AIR CONDITIONING": "COOLING",
      COOL: "COOLING",
      ELECTRIC: "ELECTRICAL",
      ELECTRICAL: "ELECTRICAL",
      PLUMB: "PLUMBING",
      PLUMBING: "PLUMBING",
      DRAIN: "DRAINS",
      DRAINS: "DRAINS",
    } as Record<string, CreateJobPayload["issueCategory"]>;
    return mapped[normalized] ?? normalized;
  }

  private normalizeUrgency(value: unknown): CreateJobPayload["urgency"] {
    if (typeof value !== "string") return "" as never;
    const normalized = this.sanitizationService
      .normalizeWhitespace(value)
      .toUpperCase();
    if (normalized === "EMERGENCY" || normalized === "URGENT") {
      return "EMERGENCY";
    }
    if (normalized === "STANDARD" || normalized === "NORMAL") {
      return "STANDARD";
    }
    // The AI prompt/tool distinguishes high-priority requests, while the
    // current persistence model intentionally stores only emergency or
    // standard urgency. Preserve the request instead of rejecting the tool
    // call; only life-safety/emergency cases belong in EMERGENCY.
    if (normalized === "HIGH" || normalized === "HIGH PRIORITY") {
      return "STANDARD";
    }
    return "" as never;
  }

  private mapUrgency(value: string): JobUrgency {
    return value === "EMERGENCY" ? JobUrgency.EMERGENCY : JobUrgency.STANDARD;
  }

  private inferPreferredWindow(
    value?: string,
  ): PreferredWindowLabel | undefined {
    if (!value) return undefined;
    const upper = value.toUpperCase().replace(/\./g, "");

    if (/\bASAP\b|AS SOON AS POSSIBLE|RIGHT AWAY|IMMEDIATELY/.test(upper)) {
      return PreferredWindowLabel.ASAP;
    }
    if (/\bMORNING\b|BEFORE NOON/.test(upper)) {
      return PreferredWindowLabel.MORNING;
    }
    if (/\bAFTERNOON\b|\bNOON\b/.test(upper)) {
      return PreferredWindowLabel.AFTERNOON;
    }
    if (/\bEVENING\b|AFTER WORK|\bNIGHT\b/.test(upper)) {
      return PreferredWindowLabel.EVENING;
    }

    const twelveHour = upper.match(
      /\b(1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(AM|PM)\b/,
    );
    if (twelveHour) {
      const hour =
        (Number(twelveHour[1]) % 12) + (twelveHour[2] === "PM" ? 12 : 0);
      return this.preferredWindowForHour(hour);
    }

    const twentyFourHour = upper.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
    return twentyFourHour
      ? this.preferredWindowForHour(Number(twentyFourHour[1]))
      : undefined;
  }

  private preferredWindowForHour(hour: number): PreferredWindowLabel {
    if (hour < 12) return PreferredWindowLabel.MORNING;
    if (hour < 17) return PreferredWindowLabel.AFTERNOON;
    return PreferredWindowLabel.EVENING;
  }
}
