import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import {
  CalendarOperationAction,
  JobStatus,
  PaymentStatus,
  Prisma,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { evaluatePaymentGate } from "../payments/payment-gate.policy";

type ReservationInput = {
  tenantId: string;
  jobId: string;
  expectedUpdatedAt: Date;
  // Trusted server routing configuration, never customer-supplied authority.
  calendarId: string;
  timeZone: string;
} & (
  | { action: "CREATE" | "RESCHEDULE"; start: Date; end: Date; label: string }
  | { action: "CANCEL" }
);

/** Local persistence foundation, deliberately NOT registered in SchedulingModule.
 * Before activation, callers must retain auth/payment/slot/availability guards
 * and explicitly compose the reviewed executor, recovery and office-review paths.
 * No Calendar, message, audit-of-success or automatic rollback occurs here.
 */
@Injectable()
export class CalendarOperationJournalService {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(input: ReservationInput) {
    this.validate(input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const original = await tx.job.findFirst({
          where: {
            id: input.jobId,
            tenantId: input.tenantId,
            deletedAt: null,
            updatedAt: input.expectedUpdatedAt,
          },
          include: {
            payment: { select: { id: true, status: true, updatedAt: true } },
          },
        });
        if (!original) throw this.conflict();
        const creating = input.action === CalendarOperationAction.CREATE;
        if (
          creating
            ? original.status !== JobStatus.CREATED ||
              original.calendarEventId !== null ||
              original.serviceWindowStart !== null ||
              original.serviceWindowEnd !== null
            : original.status !== JobStatus.ACCEPTED ||
              !original.calendarEventId?.trim() ||
              !original.serviceWindowStart ||
              !original.serviceWindowEnd ||
              original.serviceWindowEnd <= original.serviceWindowStart
        )
          throw this.conflict();
        // Replay needs finalized proof in the eventual caller, not a new journal.
        if (
          input.action === CalendarOperationAction.RESCHEDULE &&
          original.serviceWindowStart?.getTime() === input.start.getTime() &&
          original.serviceWindowEnd?.getTime() === input.end.getTime()
        )
          throw this.conflict();
        const unfinished = await tx.calendarOperation.findFirst({
          where: {
            tenantId: input.tenantId,
            jobId: input.jobId,
            finishedAt: null,
          },
          select: { id: true },
        });
        if (unfinished) throw this.conflict();
        // Re-evaluate canonical CREATE authority inside the claim transaction;
        // an upstream success response or stale preflight is not permission.
        // Do not introduce payment admission for rescheduling/cancellation.
        const paymentGate = creating
          ? evaluatePaymentGate(original.policySnapshot, original.payment)
          : null;
        if (paymentGate?.state === "LOCKED") throw this.conflict();
        const cancelling = input.action === CalendarOperationAction.CANCEL;
        const claimedUpdatedAt = new Date(
          Math.max(Date.now(), original.updatedAt.getTime() + 1),
        );
        const desired = cancelling
          ? { start: null, end: null, label: null }
          : { start: input.start, end: input.end, label: input.label };
        const changed = await tx.job.updateMany({
          where: {
            id: original.id,
            tenantId: input.tenantId,
            updatedAt: original.updatedAt,
            deletedAt: null,
            status: original.status,
            calendarEventId: original.calendarEventId,
            serviceWindowStart: original.serviceWindowStart,
            serviceWindowEnd: original.serviceWindowEnd,
            // Fail if the observed successful payment changed before this
            // statement snapshot. This does not serialize post-claim changes.
            payment:
              paymentGate?.reasonCode === "PAYMENT_SUCCEEDED"
                ? {
                    is: {
                      id: original.payment!.id,
                      tenantId: input.tenantId,
                      status: PaymentStatus.SUCCEEDED,
                      updatedAt: original.payment!.updatedAt,
                    },
                  }
                : undefined,
          },
          data: {
            status: cancelling ? JobStatus.CANCELLED : JobStatus.ACCEPTED,
            calendarEventId: cancelling ? null : original.calendarEventId,
            serviceWindowStart: desired.start,
            serviceWindowEnd: desired.end,
            preferredTimeText: desired.label,
            updatedAt: claimedUpdatedAt,
          },
        });
        if (changed.count !== 1) throw this.conflict();
        // Generate once and persist BEFORE an eventual external insert. A retry
        // must read this ID, never generate a new one after an unknown outcome.
        const calendarEventId = creating
          ? randomUUID().replaceAll("-", "")
          : original.calendarEventId!;
        return tx.calendarOperation.create({
          data: {
            tenantId: input.tenantId,
            jobId: original.id,
            action: input.action,
            calendarId: input.calendarId,
            calendarEventId,
            timeZone: input.timeZone,
            expectedUpdatedAt: original.updatedAt,
            claimedUpdatedAt,
            previousStatus: original.status,
            previousCalendarEventId: original.calendarEventId,
            previousWindowStart: original.serviceWindowStart,
            previousWindowEnd: original.serviceWindowEnd,
            previousTimeText: original.preferredTimeText,
            desiredWindowStart: desired.start,
            desiredWindowEnd: desired.end,
            desiredTimeText: desired.label,
          },
        });
      });
    } catch (error) {
      // Both reservation collisions and the partial journal index fail closed.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw this.conflict();
      throw error;
    }
  }

  private conflict() {
    return new ConflictException(
      "Appointment changed or has unfinished Calendar work.",
    );
  }

  private validate(input: ReservationInput) {
    if (
      !Object.values(CalendarOperationAction).includes(input.action) ||
      !(input.expectedUpdatedAt instanceof Date) ||
      !Number.isFinite(input.expectedUpdatedAt.getTime()) ||
      !input.calendarId?.trim() ||
      input.calendarId.length > 1024 ||
      !input.timeZone?.trim() ||
      input.timeZone.length > 128
    )
      throw new BadRequestException("Invalid Calendar operation.");
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
    } catch {
      throw new BadRequestException("Invalid Calendar time zone.");
    }
    if (
      input.action !== CalendarOperationAction.CANCEL &&
      (!(input.start instanceof Date) ||
        !(input.end instanceof Date) ||
        !Number.isFinite(input.start.getTime()) ||
        !Number.isFinite(input.end.getTime()) ||
        input.end <= input.start ||
        !input.label?.trim() ||
        input.label.length > 160)
    )
      throw new BadRequestException("Invalid Calendar window.");
  }
}
