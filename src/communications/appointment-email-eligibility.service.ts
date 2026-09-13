import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { getRequestContext } from "../common/context/request-context";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppointmentEmailRecipientService } from "./appointment-email-recipient.service";
import { customerEmailPolicy } from "./customer-email-policy";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const kinds = {
  APPOINTMENT_CONFIRMED: "confirmed",
  APPOINTMENT_RESCHEDULED: "rescheduled",
  APPOINTMENT_CANCELLED: "cancelled",
} as const;
type Kind = keyof typeof kinds;
type Row = {
  id: string;
  tenantId: string;
  jobId: string;
  kind: string;
  version: number;
  state: string;
  jobUpdatedAt: Date;
  windowStart: Date;
  windowEnd: Date;
  calendarEventHash: string;
  createdAt: Date;
  reviewedAt: Date;
  preference: string;
  currentVersion: Date;
  currentStatus: string;
  currentStart: Date | null;
  currentEnd: Date | null;
  currentCalendarId: string | null;
  identityMatches: boolean;
  receiptMatches: boolean;
  calendarSettled: boolean;
  tenantSettingsUpdatedAt: Date;
  settingsValid: boolean;
  policyPresent: boolean;
  emailPolicy: unknown;
};
type Reason =
  | "EVENT_INVALID"
  | "EVENT_STALE"
  | "CALENDAR_PENDING"
  | "EVENT_POLICY_BLOCKED"
  | "EVENT_POLICY_INVALID"
  | "CURRENT_POLICY_BLOCKED"
  | "CURRENT_POLICY_INVALID"
  | "RECIPIENT_UNAVAILABLE"
  | "CONSENT_AUTHORITY_UNAVAILABLE"
  | "EXPIRY_POLICY_UNAVAILABLE";
const validDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());
const sameDate = (a: Date | null, b: Date) =>
  validDate(a) && a.getTime() === b.getTime();

/** Inactive owner/admin diagnostic only. Never a queue admission or send token.
 * No approved email consent authority or expiry policy exists: no positive path.
 * A future dispatch must revalidate at its own atomic boundary, not trust this read.
 */
export class AppointmentEmailEligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: ConversationMemoryCipher,
  ) {}

  async evaluate(input: { intentId: string }) {
    const ctx = getRequestContext();
    if (
      !ctx?.userId?.trim() ||
      !ctx.tenantId ||
      !UUID.test(ctx.tenantId) ||
      ctx.impersonatedTenantId ||
      !["owner", "admin"].includes(ctx.role?.trim().toLowerCase() ?? "")
    )
      throw new ForbiddenException(
        "Email eligibility review requires a verified owner or admin tenant context.",
      );
    if (
      !input ||
      typeof input.intentId !== "string" ||
      !UUID.test(input.intentId) ||
      Object.keys(input).some((key) => key !== "intentId")
    )
      throw new BadRequestException(
        "Email eligibility review requires only a finalized event identifier.",
      );
    const intentId = input.intentId,
      tenantId = ctx.tenantId;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // PostgreSQL enforces no mutations; both readers use the same MVCC snapshot.
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
          SELECT e.id, e."tenantId", e."jobId", e.kind, e.version, e.state, e."jobUpdatedAt",
            e."windowStart", e."windowEnd", e."calendarEventHash", e."createdAt", e.preference,
            (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS "reviewedAt", j."updatedAt" AS "currentVersion", j.status AS "currentStatus",
            j."serviceWindowStart" AS "currentStart", j."serviceWindowEnd" AS "currentEnd", j."calendarEventId" AS "currentCalendarId",
            (e."customerId" = j."customerId" AND e."intakeSessionId" IS NOT DISTINCT FROM j."intakeSessionId") AS "identityMatches",
            NOT EXISTS (SELECT 1 FROM "CalendarOperation" pending WHERE pending."jobId" = j.id AND pending."tenantId" = j."tenantId" AND pending."finishedAt" IS NULL) AS "calendarSettled",
            t."updatedAt" AS "tenantSettingsUpdatedAt", (jsonb_typeof(t.settings) = 'object') AS "settingsValid",
            (t.settings ? 'customerEmailPreferences') AS "policyPresent", t.settings -> 'customerEmailPreferences' AS "emailPolicy",
            EXISTS (
              SELECT 1 FROM "AuditLog" a
              JOIN "SmsEnqueueIntent" sms ON sms.id::text = a.metadata ->> 'notificationIntentId'
                AND sms."tenantId" = e."tenantId" AND sms."jobId" = e."jobId" AND sms."templateKey" = e.kind
              LEFT JOIN "CalendarOperation" op ON op.id = e."calendarOperationId" AND op."tenantId" = e."tenantId" AND op."jobId" = e."jobId"
              LEFT JOIN "AppointmentCancellationSnapshot" snap ON snap."tenantId" = e."tenantId" AND snap."jobId" = e."jobId"
                AND to_char(snap."claimedUpdatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = a.metadata ->> 'claimedUpdatedAt'
                AND snap."claimedUpdatedAt" < e."jobUpdatedAt" AND snap."customerId" = e."customerId"
                AND snap."intakeSessionId" IS NOT DISTINCT FROM e."intakeSessionId"
                AND snap."windowStart" = e."windowStart" AND snap."windowEnd" = e."windowEnd" AND snap."calendarEventHash" = e."calendarEventHash"
              WHERE a.id = e."sourceAuditId" AND a."tenantId" = e."tenantId" AND a."entityType" = 'Job' AND a."entityId" = e."jobId"::text
                AND a.metadata ->> 'finalizedUpdatedAt' = to_char(e."jobUpdatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                AND a.action = CASE e.kind WHEN 'APPOINTMENT_CONFIRMED' THEN 'appointment.initial_confirmed' WHEN 'APPOINTMENT_RESCHEDULED' THEN 'appointment.customer_rescheduled' WHEN 'APPOINTMENT_CANCELLED' THEN 'appointment.customer_cancelled' END
                AND (e.kind <> 'APPOINTMENT_CANCELLED' OR snap."jobId" IS NOT NULL)
                AND ((e.source = 'CALENDAR_ACK' AND e."calendarOperationId" IS NULL AND NOT (a.metadata ? 'calendarOperationId')
                  AND a."actorType" = 'CUSTOMER' AND a."actorId" = 'customer:' || e."customerId"::text)
                OR (e.source = 'CREATE_READBACK' AND e.kind = 'APPOINTMENT_CONFIRMED' AND a."actorType" = 'SYSTEM_AI' AND a."actorId" = 'calendar-reconciliation'
                  AND a.metadata ->> 'calendarEvidence' = 'MATCHED_CREATE_READBACK' AND a.metadata ->> 'calendarOperationId' = op.id::text
                  AND op.action = 'CREATE' AND op.status = 'FINALIZED' AND op."finishedAt" IS NOT NULL
                  AND op."calendarEventId" = j."calendarEventId" AND op."desiredWindowStart" = e."windowStart" AND op."desiredWindowEnd" = e."windowEnd"))
            ) AS "receiptMatches"
          FROM "AppointmentEmailIntent" e
          JOIN "Job" j ON j.id = e."jobId" AND j."tenantId" = e."tenantId" AND j."deletedAt" IS NULL
          JOIN "TenantOrganization" t ON t.id = e."tenantId" AND t.status = 'ACTIVE'
          JOIN "Customer" c ON c.id = j."customerId" AND c."tenantId" = j."customerTenantId" AND c."tenantId" = j."tenantId" AND c."deletedAt" IS NULL
          WHERE e.id = ${intentId}::uuid AND e."tenantId" = ${tenantId}::uuid
        `);
          const row = rows[0];
          if (!row)
            throw new NotFoundException(
              "Finalized email event is unavailable for review.",
            );
          if (
            rows.length !== 1 ||
            row.id.toLowerCase() !== intentId.toLowerCase() ||
            row.tenantId.toLowerCase() !== tenantId.toLowerCase()
          )
            throw Error("Invalid projection");
          const blocked = (reason: Reason) => ({
            resolution: "blocked" as const,
            eligible: false as const,
            deliveryAuthorized: false as const,
            snapshotOnly: true as const,
            reason,
          });
          if (
            !Object.prototype.hasOwnProperty.call(kinds, row.kind) ||
            row.version !== 1 ||
            row.state !== "RECORDED" ||
            row.receiptMatches !== true ||
            ![
              row.windowStart,
              row.windowEnd,
              row.jobUpdatedAt,
              row.createdAt,
              row.reviewedAt,
              row.currentVersion,
              row.tenantSettingsUpdatedAt,
            ].every(validDate) ||
            row.windowEnd <= row.windowStart ||
            row.createdAt > row.reviewedAt ||
            !/^[0-9a-f]{64}$/.test(row.calendarEventHash) ||
            [row.windowStart, row.windowEnd].some(
              (date) =>
                date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0,
            )
          )
            return blocked("EVENT_INVALID");
          const kind = row.kind as Kind;
          if (
            row.identityMatches !== true ||
            !sameDate(row.currentVersion, row.jobUpdatedAt)
          )
            return blocked("EVENT_STALE");
          if (row.calendarSettled !== true) return blocked("CALENDAR_PENDING");
          const cancelled = kind === "APPOINTMENT_CANCELLED";
          if (
            cancelled
              ? row.currentStatus !== "CANCELLED" ||
                row.currentCalendarId !== null ||
                row.currentStart !== null ||
                row.currentEnd !== null
              : row.currentStatus !== "ACCEPTED" ||
                !row.currentCalendarId?.trim() ||
                !sameDate(row.currentStart, row.windowStart) ||
                !sameDate(row.currentEnd, row.windowEnd) ||
                createHash("sha256")
                  .update(row.currentCalendarId)
                  .digest("hex") !== row.calendarEventHash
          )
            return blocked("EVENT_STALE");
          if (row.preference !== "PERMITTED")
            return blocked(
              row.preference === "BLOCKED"
                ? "EVENT_POLICY_BLOCKED"
                : "EVENT_POLICY_INVALID",
            );
          const policy = customerEmailPolicy(
            row.settingsValid
              ? row.policyPresent
                ? { customerEmailPreferences: row.emailPolicy }
                : {}
              : null,
          );
          if (policy.source === "invalid")
            return blocked("CURRENT_POLICY_INVALID");
          if (!policy.events[kind]) return blocked("CURRENT_POLICY_BLOCKED");
          let recipient;
          try {
            recipient = await new AppointmentEmailRecipientService(
              tx,
              this.cipher,
            ).resolve({
              jobId: row.jobId,
              kind: kinds[kind],
              expectedJobUpdatedAt: row.jobUpdatedAt.toISOString(),
            });
          } catch (error) {
            if (
              error instanceof ConflictException ||
              error instanceof NotFoundException
            )
              return blocked("RECIPIENT_UNAVAILABLE");
            throw error;
          }
          // Deliberately omit the decrypted address; this binding cannot authorize a
          // later send, mailbox ownership or recipient substitution.
          return {
            ...blocked("CONSENT_AUTHORITY_UNAVAILABLE"),
            blockers: [
              "CONSENT_AUTHORITY_UNAVAILABLE",
              "EXPIRY_POLICY_UNAVAILABLE",
            ] as const,
            binding: {
              intentId: row.id,
              tenantId: row.tenantId,
              jobId: row.jobId,
              kind,
              jobUpdatedAt: row.jobUpdatedAt.toISOString(),
              tenantSettingsUpdatedAt:
                row.tenantSettingsUpdatedAt.toISOString(),
              conversationId: recipient.recipient.conversationId,
              conversationUpdatedAt: recipient.recipient.conversationUpdatedAt,
              reviewedAt: row.reviewedAt.toISOString(),
              recipientSource: "conversation_intake" as const,
              ownershipVerified: false as const,
            },
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          maxWait: 2000,
          timeout: 5000,
        },
      );
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException(
        "Email eligibility review is unavailable. Reload before trying again.",
      );
    }
  }
}
