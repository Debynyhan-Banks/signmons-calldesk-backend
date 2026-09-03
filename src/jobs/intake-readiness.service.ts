import { randomUUID } from "crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import {
  AuditActorType,
  JobUrgency,
  PaymentStatus,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { evaluatePaymentGate } from "../payments/payment-gate.policy";

const UNKNOWN_VALUES = new Set(["", "unknown", "unknown address"]);

export type IntakeMissingField =
  | "customerName"
  | "phone"
  | "serviceAddress"
  | "serviceCategory"
  | "issueSummary"
  | "urgency"
  | "preferredWindow"
  | "paymentStatus";

export interface IntakeReadiness {
  state: "READY_TO_ASSIGN" | "MISSING_INFO";
  missingFields: IntakeMissingField[];
  assessedAt: string;
}

export interface IntakeReviewSummary {
  jobId: string;
  reference: string;
  customerName: string | null;
  phone: string | null;
  serviceAddress: string | null;
  serviceCategory: string | null;
  issueSummary: string | null;
  urgency: string | null;
  priority: "EMERGENCY" | "HIGH" | "STANDARD";
  preferredWindow: string | null;
  photos: string[];
  paymentStatus: PaymentStatus | "NOT_REQUESTED";
  depositRequired: boolean;
  status: string;
  sourceChannel: string | null;
  createdAt: string;
  readiness: IntakeReadiness;
}

export interface IntakeTranscriptEntry {
  id: string;
  role: "caller" | "assistant" | "system";
  content: string;
  occurredAt: string;
}

export interface IntakeReviewDetail extends IntakeReviewSummary {
  transcript: IntakeTranscriptEntry[];
  reviewHistory: Array<{
    id: string;
    state: IntakeReadiness["state"];
    missingFields: IntakeMissingField[];
    actorId: string;
    createdAt: string;
  }>;
}

type IntakeJob = Prisma.JobGetPayload<{
  include: {
    customer: true;
    propertyAddress: true;
    serviceCategory: true;
    payment: true;
  };
}>;

@Injectable()
export class IntakeReadinessService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string): Promise<IntakeReviewSummary[]> {
    const jobs = await this.prisma.job.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: [{ urgency: "desc" }, { createdAt: "desc" }],
      take: 100,
      include: {
        customer: true,
        propertyAddress: true,
        serviceCategory: true,
        payment: true,
      },
    });

    return jobs.map((job) => this.toSummary(job));
  }

  async get(tenantId: string, jobId: string): Promise<IntakeReviewDetail> {
    const job = await this.findJob(tenantId, jobId);
    const [transcript, reviewHistory] = await Promise.all([
      this.getTranscript(tenantId, job),
      this.getReviewHistory(tenantId, jobId),
    ]);

    return { ...this.toSummary(job), transcript, reviewHistory };
  }

  async review(input: {
    tenantId: string;
    jobId: string;
    actorId: string;
    traceId?: string;
  }) {
    const job = await this.findJob(input.tenantId, input.jobId);
    const summary = this.toSummary(job);
    const audit = await this.prisma.auditLog.create({
      data: {
        id: randomUUID(),
        tenantId: input.tenantId,
        action: "job.intake_readiness_reviewed",
        actorType: AuditActorType.USER,
        actorId: input.actorId,
        entityType: "Job",
        entityId: input.jobId,
        metadata: {
          state: summary.readiness.state,
          missingFields: summary.readiness.missingFields,
        } satisfies Prisma.InputJsonValue,
        traceId: input.traceId,
      },
      select: { id: true, createdAt: true },
    });

    return {
      jobId: input.jobId,
      readiness: summary.readiness,
      review: { id: audit.id, createdAt: audit.createdAt.toISOString() },
    };
  }

  private findJob(tenantId: string, jobId: string): Promise<IntakeJob> {
    return this.prisma.job
      .findFirst({
        where: { id: jobId, tenantId, deletedAt: null },
        include: {
          customer: true,
          propertyAddress: true,
          serviceCategory: true,
          payment: true,
        },
      })
      .then((job) => {
        if (!job) throw new NotFoundException("Intake request was not found.");
        return job;
      });
  }

  private toSummary(job: IntakeJob): IntakeReviewSummary {
    const customerName = this.present(job.customer.fullName);
    const phone = this.present(job.customer.phone);
    const serviceAddress = this.present(job.propertyAddress.formattedAddress);
    const serviceCategory = this.present(job.serviceCategory.name);
    const issueSummary = this.present(job.description);
    const preferredWindow =
      this.present(job.preferredTimeText) ??
      (job.serviceWindowStart && job.serviceWindowEnd
        ? `${job.serviceWindowStart.toISOString()} — ${job.serviceWindowEnd.toISOString()}`
        : job.preferredWindowLabel);
    const depositRequired = this.booleanPolicy(
      job.policySnapshot,
      "depositRequired",
    );
    const paymentGate = evaluatePaymentGate(job.policySnapshot, job.payment);
    const paymentStatus = paymentGate.paymentStatus;
    const missingFields: IntakeMissingField[] = [];

    if (!customerName || customerName.toLowerCase() === "unknown caller")
      missingFields.push("customerName");
    if (!phone || phone.toLowerCase().startsWith("unknown-"))
      missingFields.push("phone");
    if (!serviceAddress) missingFields.push("serviceAddress");
    if (!serviceCategory) missingFields.push("serviceCategory");
    if (!issueSummary) missingFields.push("issueSummary");
    if (!job.urgency) missingFields.push("urgency");
    if (!preferredWindow) missingFields.push("preferredWindow");
    if (paymentGate.state === "LOCKED") missingFields.push("paymentStatus");

    const priority = this.priority(job);
    return {
      jobId: job.id,
      reference: job.id.replace(/-/g, "").slice(0, 8).toUpperCase(),
      customerName,
      phone,
      serviceAddress,
      serviceCategory,
      issueSummary,
      urgency: job.urgency ?? null,
      priority,
      preferredWindow,
      photos: this.photos(job.policySnapshot),
      paymentStatus,
      depositRequired,
      status: job.status,
      sourceChannel: this.sourceChannel(job.policySnapshot),
      createdAt: job.createdAt.toISOString(),
      readiness: {
        state: missingFields.length ? "MISSING_INFO" : "READY_TO_ASSIGN",
        missingFields,
        assessedAt: new Date().toISOString(),
      },
    };
  }

  private async getTranscript(
    tenantId: string,
    job: IntakeJob,
  ): Promise<IntakeTranscriptEntry[]> {
    if (!job.intakeSessionId) return [];
    const contents = await this.prisma.communicationContent.findMany({
      where: {
        tenantId,
        payload: { path: ["sessionId"], equals: job.intakeSessionId },
        AND: [{ payload: { path: ["type"], equals: "message" } }],
      },
      select: { id: true, payload: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: 100,
    });

    return contents
      .map((entry) => this.toTranscriptEntry(entry))
      .filter((entry): entry is IntakeTranscriptEntry => Boolean(entry));
  }

  private toTranscriptEntry(entry: {
    id: string;
    payload: Prisma.JsonValue;
    createdAt: Date;
  }): IntakeTranscriptEntry | null {
    if (!entry.payload || typeof entry.payload !== "object") return null;
    const payload = entry.payload as Record<string, unknown>;
    if (typeof payload.message !== "string" || !payload.message.trim())
      return null;
    const role =
      payload.role === "user"
        ? "caller"
        : payload.role === "assistant"
          ? "assistant"
          : "system";
    return {
      id: entry.id,
      role,
      content: payload.message,
      occurredAt: entry.createdAt.toISOString(),
    };
  }

  private async getReviewHistory(tenantId: string, jobId: string) {
    const audits = await this.prisma.auditLog.findMany({
      where: {
        tenantId,
        entityType: "Job",
        entityId: jobId,
        action: "job.intake_readiness_reviewed",
      },
      select: {
        id: true,
        actorId: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return audits.map((audit) => {
      const metadata = this.record(audit.metadata);
      const state: IntakeReadiness["state"] =
        metadata?.state === "READY_TO_ASSIGN"
          ? "READY_TO_ASSIGN"
          : "MISSING_INFO";
      const missingFields = Array.isArray(metadata?.missingFields)
        ? metadata.missingFields.filter((field): field is IntakeMissingField =>
            [
              "customerName",
              "phone",
              "serviceAddress",
              "serviceCategory",
              "issueSummary",
              "urgency",
              "preferredWindow",
              "paymentStatus",
            ].includes(String(field)),
          )
        : [];
      return {
        id: audit.id,
        state,
        missingFields,
        actorId: audit.actorId,
        createdAt: audit.createdAt.toISOString(),
      };
    });
  }

  private present(value: string | null | undefined): string | null {
    const normalized = value?.trim() ?? "";
    return UNKNOWN_VALUES.has(normalized.toLowerCase()) ? null : normalized;
  }

  private record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private booleanPolicy(snapshot: Prisma.JsonValue, field: string): boolean {
    return this.record(snapshot)?.[field] === true;
  }

  private priority(job: IntakeJob): "EMERGENCY" | "HIGH" | "STANDARD" {
    if (job.urgency === JobUrgency.EMERGENCY) return "EMERGENCY";
    if (job.urgency === JobUrgency.HIGH) return "HIGH";
    return "STANDARD";
  }

  private photos(snapshot: Prisma.JsonValue): string[] {
    const value = this.record(snapshot)?.photos;
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is string =>
          typeof item === "string" && /^https:\/\//.test(item),
      )
      .slice(0, 10);
  }

  private sourceChannel(snapshot: Prisma.JsonValue): string | null {
    const attribution = this.record(this.record(snapshot)?.leadAttribution);
    return typeof attribution?.channel === "string"
      ? attribution.channel
      : null;
  }
}
