import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { getRequestContext } from "../common/context/request-context";
import { PrismaService } from "../prisma/prisma.service";
import {
  calendarReadbackNotBefore,
  calendarReadbackReady,
} from "./calendar-readback-deadline";

// Deliberately exclude provider targets, windows/text, claimed job versions,
// tenant identity, and all related job/customer/payment records.
const reviewSelect = {
  id: true,
  jobId: true,
  action: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  finishedAt: true,
  readbackNotBefore: true,
} satisfies Prisma.CalendarOperationSelect;
type ReviewRow = Prisma.CalendarOperationGetPayload<{
  select: typeof reviewSelect;
}>;
const HISTORY_LIMIT = 100;
const recoveryRequestActions = [
  "appointment.applied_create_readback_requested",
  "appointment.uncertain_create_readback_requested",
];

/** Inactive internal projection. Future callers require RequestAuthGuard and
 * TenantGuard. Never register a public route or infer provider truth from this
 * journal snapshot. Reads cannot hold, retry, recover, or release any work.
 */
@Injectable()
export class CalendarReviewStateService {
  constructor(private readonly prisma: PrismaService) {}

  async listForJob(input: { jobId: string }) {
    const tenantId = this.reviewTenant();
    this.requireId(input.jobId);
    try {
      const rows = await this.prisma.calendarOperation.findMany({
        where: { tenantId, jobId: input.jobId },
        select: reviewSelect,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: HISTORY_LIMIT + 1,
      });
      return {
        snapshotOnly: true as const,
        items: rows.slice(0, HISTORY_LIMIT).map((row) => this.project(row)),
        hasMore: rows.length > HISTORY_LIMIT,
      };
    } catch {
      throw this.unavailable();
    }
  }

  async read(input: { operationId: string }) {
    const tenantId = this.reviewTenant();
    this.requireId(input.operationId);
    let row: ReviewRow | null;
    try {
      row = await this.prisma.calendarOperation.findUnique({
        where: { id_tenantId: { id: input.operationId, tenantId } },
        select: reviewSelect,
      });
      return row ? this.project(row) : this.missing();
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw this.unavailable();
    }
  }

  async listRecoveryRequests(input: { operationId: string }) {
    const tenantId = this.reviewTenant();
    this.requireId(input.operationId);
    try {
      const operation = await this.prisma.calendarOperation.findUnique({
        where: { id_tenantId: { id: input.operationId, tenantId } },
        select: { id: true },
      });
      if (!operation) this.missing();
      const rows = await this.prisma.auditLog.findMany({
        where: {
          tenantId,
          entityType: "CalendarOperation",
          entityId: input.operationId,
          actorType: "USER",
          action: { in: recoveryRequestActions },
        },
        select: { id: true, action: true, createdAt: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: HISTORY_LIMIT + 1,
      });
      return {
        snapshotOnly: true as const,
        requestOnly: true as const,
        items: rows.slice(0, HISTORY_LIMIT).map((row) => {
          const kind =
            row.action === recoveryRequestActions[0]
              ? ("applied_create" as const)
              : row.action === recoveryRequestActions[1]
                ? ("uncertain_create" as const)
                : null;
          if (!kind) throw new Error("Unsupported recovery request");
          return {
            requestId: row.id,
            kind,
            requestedAt: row.createdAt.toISOString(),
          };
        }),
        hasMore: rows.length > HISTORY_LIMIT,
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw this.unavailable();
    }
  }

  private project(row: ReviewRow) {
    const unfinishedCreate = row.action === "CREATE" && row.finishedAt === null;
    const notBefore =
      unfinishedCreate && row.status === "UNCERTAIN"
        ? calendarReadbackNotBefore(row)
        : null;
    const recoveryReviewCandidate =
      unfinishedCreate && row.status === "APPLIED"
        ? ("applied_create" as const)
        : notBefore && calendarReadbackReady(notBefore)
          ? ("uncertain_create" as const)
          : null;
    return {
      snapshotOnly: true as const,
      operationId: row.id,
      jobId: row.jobId,
      action: row.action,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      // A local timing hint, not current job/provider truth or permission.
      recoveryReviewCandidate,
      recoveryReadbackNotBefore:
        notBefore && Number.isFinite(notBefore.getTime())
          ? notBefore.toISOString()
          : null,
      // A point-in-time hint, NOT permission, crash proof or a booking receipt.
      // The hold service must independently recheck role, ack, status and CAS.
      pendingHoldReviewCandidate:
        row.action === "CREATE" &&
        row.status === "PENDING" &&
        row.finishedAt === null,
    };
  }

  private reviewTenant() {
    const context = getRequestContext();
    if (!context?.userId?.trim() || !context.tenantId?.trim())
      throw new UnauthorizedException("Verified review identity is required.");
    if (!["owner", "admin"].includes(context.role?.trim().toLowerCase() ?? ""))
      throw new ForbiddenException(
        "Calendar review requires an owner or admin role.",
      );
    return context.tenantId;
  }

  private requireId(id: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new BadRequestException("A valid review reference is required.");
  }

  private missing(): never {
    throw new NotFoundException("Calendar operation was not found.");
  }

  private unavailable() {
    return new ServiceUnavailableException(
      "Calendar review state is unavailable. Refresh before taking further action.",
    );
  }
}
