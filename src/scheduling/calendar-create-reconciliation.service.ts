import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  AuditActorType,
  CalendarOperation,
  CalendarOperationStatus,
  JobStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SmsEnqueueIntentService } from "../communications/sms-enqueue-intent.service";
import {
  CalendarEventReader,
  CalendarEventSnapshot,
  CalendarReadResult,
} from "./calendar-event-reader";
import { CALENDAR_CREATE_READER_GRACE_MS } from "./calendar-event-creator";
import { createHash } from "node:crypto";

type Result = {
  status: "finalized" | "already_finalized" | "pending" | "needs_review";
};

/** CREATE read-back reconciliation only. Not registered, scheduled or routed.
 * Does not create Calendar events or process/send messages. Future activation
 * requires journal-aware customer/dispatch/message gates and guarded creation.
 */
@Injectable()
export class CalendarCreateReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: CalendarEventReader,
    private readonly intents: SmsEnqueueIntentService,
  ) {}

  async reconcile(input: {
    tenantId: string;
    operationId: string;
    // Reviewed recovery may only consume its acknowledged admission version.
    // Omitted for the existing executor/recovery paths; never bypasses grace.
    expectedUpdatedAt?: Date;
  }): Promise<Result> {
    const operation = await this.prisma.calendarOperation.findUnique({
      where: {
        id_tenantId: { id: input.operationId, tenantId: input.tenantId },
      },
    });
    if (!operation)
      throw new NotFoundException("Calendar operation was not found.");
    if (
      input.expectedUpdatedAt &&
      operation.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
    )
      throw new ConflictException(
        "Calendar operation changed. Refresh review state.",
      );
    if (operation.action !== "CREATE")
      throw new ConflictException(
        "Only initial booking reconciliation is supported.",
      );
    // This reports a historical journal receipt, NOT current Calendar status.
    if (operation.status === "FINALIZED")
      return { status: "already_finalized" };
    if (operation.finishedAt || operation.status === "NEEDS_REVIEW")
      return { status: "needs_review" };
    // PENDING belongs to the executor. Reading a not-yet-attempted event can
    // turn absence/unavailability into a hold and consume its one-shot latch.
    // Even apparently matching evidence must not bypass durable attempt order.
    if (operation.status === "PENDING") return { status: "pending" };
    // UNCERTAIN is also the active-attempt marker. The only approved creator
    // bounds its complete write window below this grace period. A crashed
    // executor becomes eligible for read-only recovery after the grace; an
    // APPLIED handoff is eligible immediately. Neither path can reinsert.
    if (
      operation.status === "UNCERTAIN" &&
      Date.now() <
        operation.updatedAt.getTime() + CALENDAR_CREATE_READER_GRACE_MS
    )
      return { status: "pending" };
    if (!futureWindow(operation)) return this.hold(operation, "NEEDS_REVIEW");
    const job = await this.prisma.job.findFirst({
      where: this.claimWhere(operation),
    });
    if (!job) return this.hold(operation, "NEEDS_REVIEW");

    let read: CalendarReadResult;
    try {
      read = await this.calendar.read(
        operation.calendarId,
        operation.calendarEventId,
      );
    } catch {
      read = { outcome: "unavailable" };
    }
    if (read.outcome === "unavailable")
      return this.hold(operation, "UNCERTAIN");
    if (read.outcome !== "found" || !matches(operation, read.event))
      return this.hold(operation, "NEEDS_REVIEW");

    try {
      await this.prisma.$transaction(async (tx) => {
        if (!futureWindow(operation))
          throw new ConflictException("Appointment window has already begun.");
        // Conditional ownership of the observed journal version. A late read or
        // failure cannot replace a newer review decision or finalized receipt.
        const completed = await tx.calendarOperation.updateMany({
          where: this.operationWhere(operation),
          data: {
            status: "FINALIZED",
            finishedAt: new Date(),
            updatedAt: advance(operation.updatedAt),
          },
        });
        if (completed.count !== 1)
          throw new ConflictException("Calendar operation changed.");
        const changed = await tx.job.updateMany({
          where: this.claimWhere(operation),
          data: {
            calendarEventId: operation.calendarEventId,
            updatedAt: advance(operation.claimedUpdatedAt),
          },
        });
        if (changed.count !== 1)
          throw new ConflictException("Appointment reservation changed.");
        const intent = await this.intents.recordConfirmation(tx, {
          tenantId: operation.tenantId,
          jobId: operation.jobId,
        });
        await tx.auditLog.create({
          data: {
            tenantId: operation.tenantId,
            action: "appointment.initial_confirmed",
            actorType: AuditActorType.SYSTEM_AI,
            actorId: "calendar-reconciliation",
            entityType: "Job",
            entityId: operation.jobId,
            metadata: {
              notificationIntentId: intent.id,
              calendarOperationId: operation.id,
              calendarEvidence: "MATCHED_CREATE_READBACK",
              observedEventEtagHash: createHash("sha256")
                .update(read.event.etag)
                .digest("hex"),
            },
          },
        });
      });
      return { status: "finalized" };
    } catch (error) {
      // Includes commit-acknowledgment loss. Read the receipt before deciding;
      // never undo the appointment or manufacture a second intent.
      return this.hold(
        operation,
        error instanceof ConflictException ? "NEEDS_REVIEW" : "UNCERTAIN",
      );
    }
  }

  private claimWhere(operation: CalendarOperation) {
    return {
      id: operation.jobId,
      tenantId: operation.tenantId,
      deletedAt: null,
      status: JobStatus.ACCEPTED,
      calendarEventId: null,
      updatedAt: operation.claimedUpdatedAt,
      serviceWindowStart: operation.desiredWindowStart,
      serviceWindowEnd: operation.desiredWindowEnd,
      preferredTimeText: operation.desiredTimeText,
    };
  }

  private operationWhere(operation: CalendarOperation) {
    return {
      id: operation.id,
      tenantId: operation.tenantId,
      action: operation.action,
      status: operation.status,
      updatedAt: operation.updatedAt,
      finishedAt: null,
    };
  }

  private async hold(
    operation: CalendarOperation,
    status: "UNCERTAIN" | "NEEDS_REVIEW",
  ): Promise<Result> {
    await this.prisma.calendarOperation.updateMany({
      where: this.operationWhere(operation),
      data: { status, updatedAt: advance(operation.updatedAt) },
    });
    const latest = await this.prisma.calendarOperation.findUnique({
      where: {
        id_tenantId: { id: operation.id, tenantId: operation.tenantId },
      },
      select: { status: true },
    });
    if (latest?.status === CalendarOperationStatus.FINALIZED)
      return { status: "already_finalized" };
    return {
      status:
        !latest ||
        latest.status === "NEEDS_REVIEW" ||
        latest.status === "ABORTED"
          ? "needs_review"
          : "pending",
    };
  }
}

function advance(value: Date) {
  return new Date(Math.max(Date.now(), value.getTime() + 1));
}

function futureWindow(operation: CalendarOperation) {
  // Do not manufacture a delayed confirmation after the arrival window starts.
  // Historical repair requires an explicit operator policy, not this reconciler.
  return Boolean(
    operation.desiredWindowStart &&
      operation.desiredWindowEnd &&
      operation.desiredWindowStart.getTime() > Date.now() &&
      operation.desiredWindowEnd > operation.desiredWindowStart,
  );
}

function matches(operation: CalendarOperation, event: CalendarEventSnapshot) {
  const instant = (value: string) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
      ? Date.parse(value)
      : NaN;
  return (
    event.id === operation.calendarEventId &&
    event.status === "confirmed" &&
    event.blockingSingleEvent &&
    event.etag.trim().length > 0 &&
    event.etag.length <= 256 &&
    event.tenantId === operation.tenantId &&
    event.jobId === operation.jobId &&
    event.operationId === operation.id &&
    instant(event.start) === operation.desiredWindowStart?.getTime() &&
    instant(event.end) === operation.desiredWindowEnd?.getTime()
  );
}
