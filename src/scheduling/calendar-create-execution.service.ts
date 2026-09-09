import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { CalendarOperation } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CalendarEventCreator } from "./calendar-event-creator";
import { CalendarCreateReconciliationService } from "./calendar-create-reconciliation.service";

/** Inactive internal seam for an ALREADY authorized, persisted CREATE reservation.
 * No route/worker/module registration or request-auth/availability bypass is added.
 * PENDING -> UNCERTAIN is a durable one-shot attempt latch, NOT a retry lease.
 */
@Injectable()
export class CalendarCreateExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly creator: CalendarEventCreator,
    private readonly reconciliation: CalendarCreateReconciliationService,
  ) {}

  async execute(input: { tenantId: string; operationId: string }) {
    const operation = await this.prisma.calendarOperation.findUnique({
      where: {
        id_tenantId: { id: input.operationId, tenantId: input.tenantId },
      },
    });
    if (!operation)
      throw new NotFoundException("Calendar operation was not found.");
    if (operation.action !== "CREATE")
      throw new ConflictException(
        "Only initial booking execution is supported.",
      );
    if (operation.status === "FINALIZED")
      return { status: "already_finalized" };
    if (operation.finishedAt || operation.status === "NEEDS_REVIEW")
      return { status: "needs_review" };
    // A concurrent caller, failed acknowledgment or restart must never insert again.
    if (operation.status !== "PENDING") return { status: "pending" };
    if (
      !futureWindow(operation) ||
      !/^[0-9a-f]{32}$/.test(operation.calendarEventId)
    )
      return this.hold(operation);
    const claimedAt = advance(operation.claimedUpdatedAt);
    const attemptedAt = advance(operation.updatedAt);
    let claimed: boolean;
    try {
      claimed = await this.prisma.$transaction(async (tx) => {
        const latch = await tx.calendarOperation.updateMany({
          where: this.operationWhere(operation),
          data: {
            status: "UNCERTAIN",
            claimedUpdatedAt: claimedAt,
            updatedAt: attemptedAt,
          },
        });
        if (latch.count !== 1) return false;
        const job = await tx.job.updateMany({
          where: this.jobWhere(operation),
          data: { updatedAt: claimedAt },
        });
        if (job.count !== 1 || !futureWindow(operation))
          throw new ConflictException(
            "Reservation changed before Calendar execution.",
          );
        return true;
      });
    } catch (error) {
      if (error instanceof ConflictException) return this.hold(operation);
      // An unknown DB commit outcome must never be followed by an insert.
      throw error;
    }
    if (!claimed) return { status: "pending" };
    const attempted = {
      ...operation,
      status: "UNCERTAIN" as const,
      claimedUpdatedAt: claimedAt,
      updatedAt: attemptedAt,
    };
    if (
      !futureWindow(attempted) ||
      !(await this.prisma.calendarOperation.findFirst({
        where: this.operationWhere(attempted),
        select: { id: true },
      })) ||
      !(await this.prisma.job.findFirst({
        where: this.jobWhere(attempted),
        select: { id: true },
      }))
    )
      return this.hold(attempted);
    try {
      await this.creator.create({
        calendarId: operation.calendarId,
        eventId: operation.calendarEventId,
        tenantId: operation.tenantId,
        jobId: operation.jobId,
        operationId: operation.id,
        start: operation.desiredWindowStart!,
        end: operation.desiredWindowEnd!,
        timeZone: operation.timeZone,
      });
    } catch {
      // Even a thrown adapter result is unknown. Only read-back may finalize.
    }
    // APPLIED means the bounded adapter attempt has exited and read-back may
    // begin; it is not provider-success evidence. A crash before this write
    // leaves UNCERTAIN for delayed read-only recovery after the grace window.
    try {
      await this.prisma.calendarOperation.updateMany({
        where: this.operationWhere(attempted),
        data: {
          status: "APPLIED",
          updatedAt: advance(attempted.updatedAt),
        },
      });
    } catch {
      // Unknown handoff-write outcomes are safe to read: a fresh UNCERTAIN is
      // held by the reader, while APPLIED permits reconciliation.
    }
    return this.reconciliation.reconcile(input);
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

  private jobWhere(operation: CalendarOperation) {
    return {
      id: operation.jobId,
      tenantId: operation.tenantId,
      deletedAt: null,
      status: "ACCEPTED" as const,
      calendarEventId: null,
      updatedAt: operation.claimedUpdatedAt,
      serviceWindowStart: operation.desiredWindowStart,
      serviceWindowEnd: operation.desiredWindowEnd,
      preferredTimeText: operation.desiredTimeText,
      assignedUserId: null,
      technicianStatus: null,
    };
  }

  private async hold(operation: CalendarOperation) {
    await this.prisma.calendarOperation.updateMany({
      where: this.operationWhere(operation),
      data: { status: "NEEDS_REVIEW", updatedAt: advance(operation.updatedAt) },
    });
    return { status: "needs_review" };
  }
}

function advance(value: Date) {
  return new Date(Math.max(Date.now(), value.getTime() + 1));
}
function futureWindow(operation: CalendarOperation) {
  return Boolean(
    operation.desiredWindowStart &&
      operation.desiredWindowEnd &&
      operation.desiredWindowStart.getTime() > Date.now() &&
      operation.desiredWindowEnd > operation.desiredWindowStart,
  );
}
