import { Injectable, NotFoundException } from "@nestjs/common";
import { AuditActorType, JobUrgency, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  JobNotificationService,
  NotificationDeliveryOutcome,
} from "./job-notification.service";
import type { JobRecord } from "./interfaces/job-repository.interface";

type UrgencyLevel = "EMERGENCY" | "HIGH" | "STANDARD";
const ESCALATION_DEDUP_WINDOW_MS = 5 * 60 * 1000;

export interface UrgencyRationale {
  decisionSource: "AI_INTAKE" | "OPERATOR_OVERRIDE" | "LEGACY_PERSISTED";
  reasonCodes: string[];
  triggerDetails: string[];
  confidenceNote: string;
}

export interface EscalationPathStep {
  order: number;
  label: string;
  required: boolean;
}

type UrgencyJob = Prisma.JobGetPayload<{
  include: {
    customer: true;
    propertyAddress: true;
    serviceCategory: true;
  };
}>;

@Injectable()
export class UrgencyReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: JobNotificationService,
  ) {}

  async list(tenantId: string) {
    const jobs = await this.prisma.job.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        customer: true,
        propertyAddress: true,
        serviceCategory: true,
      },
    });

    return jobs
      .sort((left, right) => this.rank(right.urgency) - this.rank(left.urgency))
      .map((job) => this.toSummary(job));
  }

  async get(tenantId: string, jobId: string) {
    const job = await this.findJob(tenantId, jobId);
    const history = await this.history(tenantId, jobId);
    return { ...this.toSummary(job), history };
  }

  async override(input: {
    tenantId: string;
    jobId: string;
    actorId: string;
    urgency: UrgencyLevel;
    reason: string;
    traceId?: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const job = await transaction.job.findFirst({
        where: { id: input.jobId, tenantId: input.tenantId, deletedAt: null },
        select: { id: true, urgency: true, policySnapshot: true },
      });
      if (!job) throw new NotFoundException("Urgency review was not found.");

      if (job.urgency === input.urgency) {
        return {
          jobId: job.id,
          previousUrgency: job.urgency,
          urgency: job.urgency,
          changed: false,
          override: null,
        };
      }

      const changedAt = new Date();
      const snapshot = this.record(job.policySnapshot) ?? {};
      await transaction.job.update({
        where: { id_tenantId: { id: job.id, tenantId: input.tenantId } },
        data: {
          urgency: input.urgency as JobUrgency,
          policySnapshot: {
            ...snapshot,
            urgencyDecision: {
              source: "OPERATOR_OVERRIDE",
              level: input.urgency,
              reasonCodes: ["OPERATOR_OVERRIDE"],
              confidenceNote: "Authorized operator decision.",
            },
          } satisfies Prisma.InputJsonValue,
        },
      });
      const audit = await transaction.auditLog.create({
        data: {
          tenantId: input.tenantId,
          action: "job.urgency_overridden",
          actorType: AuditActorType.USER,
          actorId: input.actorId,
          entityType: "Job",
          entityId: job.id,
          metadata: {
            previousUrgency: job.urgency,
            urgency: input.urgency,
            reason: input.reason,
            decisionSource: "OPERATOR_OVERRIDE",
            changedAt: changedAt.toISOString(),
          } satisfies Prisma.InputJsonValue,
          traceId: input.traceId,
        },
        select: { id: true, createdAt: true },
      });

      return {
        jobId: job.id,
        previousUrgency: job.urgency,
        urgency: input.urgency,
        changed: true,
        override: {
          id: audit.id,
          actorId: input.actorId,
          reason: input.reason,
          createdAt: audit.createdAt.toISOString(),
        },
      };
    });
  }

  async escalate(input: {
    tenantId: string;
    jobId: string;
    actorId: string;
    traceId?: string;
  }) {
    const job = await this.findJob(input.tenantId, input.jobId);
    const recentEscalation = await this.prisma.auditLog.findFirst({
      where: {
        tenantId: input.tenantId,
        entityType: "Job",
        entityId: input.jobId,
        action: "job.urgency_escalated",
        createdAt: {
          gte: new Date(Date.now() - ESCALATION_DEDUP_WINDOW_MS),
        },
      },
      select: {
        id: true,
        actorId: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    if (recentEscalation) {
      const metadata = this.record(recentEscalation.metadata);
      return {
        jobId: input.jobId,
        urgency: job.urgency,
        changed: false,
        escalation: {
          id: recentEscalation.id,
          actorId: recentEscalation.actorId,
          recipientGroup: "operations",
          deliveries: this.deliveryHistory(metadata?.deliveries),
          createdAt: recentEscalation.createdAt.toISOString(),
        },
      };
    }
    const deliveries = await this.notifications.notifyUrgencyEscalation(
      this.toJobRecord(job),
    );
    const deliveryMetadata = deliveries.map((delivery) => ({
      channel: delivery.channel,
      recipientGroup: delivery.recipientGroup,
      outcome: delivery.outcome,
    }));
    const requestedAt = new Date();
    const audit = await this.prisma.auditLog.create({
      data: {
        tenantId: input.tenantId,
        action: "job.urgency_escalated",
        actorType: AuditActorType.USER,
        actorId: input.actorId,
        entityType: "Job",
        entityId: input.jobId,
        metadata: {
          urgency: job.urgency,
          recipientGroup: "operations",
          deliveries: deliveryMetadata,
          requestedAt: requestedAt.toISOString(),
        } satisfies Prisma.InputJsonValue,
        traceId: input.traceId,
      },
      select: { id: true, createdAt: true },
    });
    return {
      jobId: input.jobId,
      urgency: job.urgency,
      changed: true,
      escalation: {
        id: audit.id,
        actorId: input.actorId,
        recipientGroup: "operations",
        deliveries,
        createdAt: audit.createdAt.toISOString(),
      },
    };
  }

  private async findJob(tenantId: string, jobId: string): Promise<UrgencyJob> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, tenantId, deletedAt: null },
      include: {
        customer: true,
        propertyAddress: true,
        serviceCategory: true,
      },
    });
    if (!job) throw new NotFoundException("Urgency review was not found.");
    return job;
  }

  private toSummary(job: UrgencyJob) {
    return {
      jobId: job.id,
      reference: job.id.replace(/-/g, "").slice(0, 8).toUpperCase(),
      urgency: job.urgency as UrgencyLevel,
      serviceCategory: job.serviceCategory.name,
      status: job.status,
      createdAt: job.createdAt.toISOString(),
      rationale: this.rationale(job),
      escalationPath: this.escalationPath(job.urgency),
    };
  }

  private rationale(job: UrgencyJob): UrgencyRationale {
    const decision = this.record(
      this.record(job.policySnapshot)?.urgencyDecision,
    );
    const source = this.decisionSource(decision?.source);
    const reasonCodes = this.reasonCodes(decision?.reasonCodes, job.urgency);
    return {
      decisionSource: source,
      reasonCodes,
      triggerDetails: reasonCodes.map((code) => this.reasonLabel(code)),
      confidenceNote:
        typeof decision?.confidenceNote === "string"
          ? decision.confidenceNote
          : "Legacy classification; operator verification required.",
    };
  }

  private escalationPath(urgency: JobUrgency): EscalationPathStep[] {
    if (urgency === JobUrgency.EMERGENCY) {
      return [
        { order: 1, label: "Notify operations immediately", required: true },
        { order: 2, label: "Human review before routine work", required: true },
      ];
    }
    if (urgency === JobUrgency.HIGH) {
      return [
        { order: 1, label: "Notify the dispatch queue", required: true },
        { order: 2, label: "Review before standard requests", required: true },
      ];
    }
    return [
      {
        order: 1,
        label: "Remain in the standard review queue",
        required: false,
      },
    ];
  }

  private async history(tenantId: string, jobId: string) {
    const audits = await this.prisma.auditLog.findMany({
      where: {
        tenantId,
        entityType: "Job",
        entityId: jobId,
        action: { in: ["job.urgency_overridden", "job.urgency_escalated"] },
      },
      select: {
        id: true,
        action: true,
        actorId: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return audits.map((audit) => ({
      id: audit.id,
      type:
        audit.action === "job.urgency_overridden"
          ? ("override" as const)
          : ("escalation" as const),
      actorId: audit.actorId,
      createdAt: audit.createdAt.toISOString(),
      details: this.safeHistoryDetails(audit.action, audit.metadata),
    }));
  }

  private safeHistoryDetails(action: string, metadata: Prisma.JsonValue) {
    const value = this.record(metadata) ?? {};
    if (action === "job.urgency_overridden") {
      return {
        previousUrgency: this.string(value.previousUrgency),
        urgency: this.string(value.urgency),
        reason: this.string(value.reason),
      };
    }
    return {
      urgency: this.string(value.urgency),
      recipientGroup: "operations",
      deliveries: this.deliveryHistory(value.deliveries),
    };
  }

  private deliveryHistory(value: unknown): NotificationDeliveryOutcome[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is NotificationDeliveryOutcome => {
      const record = this.record(item);
      return (
        Boolean(record) &&
        ["email", "sms", "internal"].includes(this.string(record?.channel)) &&
        ["delivered", "failed", "misconfigured", "not_configured"].includes(
          this.string(record?.outcome),
        )
      );
    });
  }

  private toJobRecord(job: UrgencyJob): JobRecord {
    const snapshot = this.record(job.policySnapshot) ?? {};
    return {
      id: job.id,
      tenantId: job.tenantId,
      customerName: job.customer.fullName,
      phone: job.customer.phone,
      address: job.propertyAddress.formattedAddress,
      issueCategory: job.serviceCategory.name,
      urgency: job.urgency,
      description: job.description ?? undefined,
      preferredTime: job.preferredTimeText ?? undefined,
      preferredTimeText: job.preferredTimeText ?? undefined,
      propertyType: this.propertyType(snapshot.propertyType),
      serviceIntent: this.serviceIntent(snapshot.serviceIntent),
      serviceWindowStart: job.serviceWindowStart ?? undefined,
      serviceWindowEnd: job.serviceWindowEnd ?? undefined,
      calendarEventId: job.calendarEventId ?? undefined,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private reasonCodes(value: unknown, urgency: JobUrgency): string[] {
    if (Array.isArray(value)) {
      const codes = value.filter(
        (item): item is string => typeof item === "string" && item.length <= 80,
      );
      if (codes.length) return codes.slice(0, 5);
    }
    if (urgency === JobUrgency.EMERGENCY)
      return ["LEGACY_EMERGENCY_CLASSIFICATION"];
    if (urgency === JobUrgency.HIGH) return ["LEGACY_HIGH_CLASSIFICATION"];
    return ["NO_ESCALATION_SIGNAL"];
  }

  private reasonLabel(code: string): string {
    const labels: Record<string, string> = {
      QUALIFYING_EMERGENCY_SIGNAL:
        "A qualifying emergency signal was recorded during intake.",
      TIME_SENSITIVE_SERVICE_SIGNAL:
        "A time-sensitive essential-service need was recorded.",
      NO_ESCALATION_SIGNAL:
        "No emergency or high-priority signal was recorded.",
      OPERATOR_OVERRIDE: "An authorized operator changed the classification.",
      LEGACY_EMERGENCY_CLASSIFICATION:
        "This legacy request was persisted as emergency.",
      LEGACY_HIGH_CLASSIFICATION:
        "This legacy request was persisted as high priority.",
    };
    return labels[code] ?? "A bounded operational reason code was recorded.";
  }

  private decisionSource(value: unknown): UrgencyRationale["decisionSource"] {
    return value === "AI_INTAKE" || value === "OPERATOR_OVERRIDE"
      ? value
      : "LEGACY_PERSISTED";
  }

  private rank(urgency: JobUrgency): number {
    if (urgency === JobUrgency.EMERGENCY) return 3;
    if (urgency === JobUrgency.HIGH) return 2;
    return 1;
  }

  private record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private string(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  private propertyType(value: unknown): JobRecord["propertyType"] {
    return value === "RESIDENTIAL" || value === "COMMERCIAL"
      ? value
      : "MANAGED";
  }

  private serviceIntent(value: unknown): JobRecord["serviceIntent"] {
    return ["DIAGNOSTIC", "REPAIR", "INSTALLATION", "MAINTENANCE"].includes(
      this.string(value),
    )
      ? (value as JobRecord["serviceIntent"])
      : "OTHER";
  }
}
