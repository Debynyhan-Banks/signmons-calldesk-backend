import { createHash } from "node:crypto";
import {
  calendarOperationPending,
  unfinishedCalendarOperations,
} from "../scheduling/calendar-operation-guard";
import { JobStatus, Prisma, TechnicianJobStatus } from "@prisma/client";
import { TransactionalMessageTemplateKey } from "./transactional-message-template.service";

export const transactionalMessageJobSelect = {
  calendarOperations: unfinishedCalendarOperations,
  id: true,
  status: true,
  deletedAt: true,
  technicianStatus: true,
  technicianStatusUpdatedAt: true,
  calendarEventId: true,
  serviceWindowStart: true,
  serviceWindowEnd: true,
  tenant: { select: { name: true, timezone: true, settings: true } },
  customer: { select: { phone: true } },
  assignedUser: { select: { id: true, fullName: true } },
} satisfies Prisma.JobSelect;

export type TransactionalMessageJob = Prisma.JobGetPayload<{
  select: typeof transactionalMessageJobSelect;
}>;

export type TransactionalMessageState =
  | "AVAILABLE"
  | "MISSING"
  | "CALENDAR_PENDING"
  | "INCOMPATIBLE";

export function evaluateTransactionalMessageState(
  templateKey: TransactionalMessageTemplateKey,
  job: TransactionalMessageJob | null,
): TransactionalMessageState {
  if (!job || job.deletedAt) return "MISSING";
  if (calendarOperationPending(job)) return "CALENDAR_PENDING";
  // Legacy CREATE can retain a reservation after an unknown provider outcome
  // without a journal row. Local ACCEPTED/window state is not confirmation.
  // Reuse the recoverable hold before comparing hashes or spending retries.
  if (
    job.status === JobStatus.ACCEPTED &&
    !job.calendarEventId?.trim() &&
    (job.serviceWindowStart || job.serviceWindowEnd)
  ) {
    return "CALENDAR_PENDING";
  }

  const cancellation =
    templateKey === TransactionalMessageTemplateKey.APPOINTMENT_CANCELLED;
  const onTheWay =
    templateKey === TransactionalMessageTemplateKey.TECHNICIAN_ON_THE_WAY;
  if (
    cancellation
      ? job.status !== JobStatus.CANCELLED
      : job.status === JobStatus.CANCELLED || job.status === JobStatus.COMPLETED
  ) {
    return "INCOMPATIBLE";
  }
  if (
    onTheWay &&
    (!job.assignedUser || job.technicianStatus !== TechnicianJobStatus.EN_ROUTE)
  ) {
    return "INCOMPATIBLE";
  }
  if (
    !cancellation &&
    !onTheWay &&
    (!job.calendarEventId ||
      !job.serviceWindowStart ||
      !job.serviceWindowEnd ||
      job.serviceWindowEnd.getTime() <= job.serviceWindowStart.getTime())
  ) {
    return "INCOMPATIBLE";
  }
  return "AVAILABLE";
}

export function transactionalMessageStateHash(
  templateKey: TransactionalMessageTemplateKey,
  job: TransactionalMessageJob,
): string {
  const common = {
    templateKey,
    jobId: job.id,
    status: job.status,
    customerPhone: job.customer.phone,
    contractorName: job.tenant.name,
    timezone: job.tenant.timezone,
  };
  const state =
    templateKey === TransactionalMessageTemplateKey.APPOINTMENT_CANCELLED
      ? common
      : templateKey === TransactionalMessageTemplateKey.TECHNICIAN_ON_THE_WAY
        ? {
            ...common,
            assignedUserId: job.assignedUser?.id ?? null,
            technicianName: job.assignedUser?.fullName ?? null,
            technicianStatus: job.technicianStatus,
            technicianStatusUpdatedAt:
              job.technicianStatusUpdatedAt?.toISOString() ?? null,
          }
        : {
            ...common,
            calendarEventId: job.calendarEventId,
            serviceWindowStart: job.serviceWindowStart?.toISOString() ?? null,
            serviceWindowEnd: job.serviceWindowEnd?.toISOString() ?? null,
          };

  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

export function parseTransactionalMessageTemplateKey(
  value: unknown,
): TransactionalMessageTemplateKey | null {
  return typeof value === "string" &&
    Object.values(TransactionalMessageTemplateKey).includes(
      value as TransactionalMessageTemplateKey,
    )
    ? (value as TransactionalMessageTemplateKey)
    : null;
}
