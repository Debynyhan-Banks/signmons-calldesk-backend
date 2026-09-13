import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { getRequestContext } from "../common/context/request-context";
import { extractIntakeEmail } from "../conversations/conversation-email.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { PrismaService } from "../prisma/prisma.service";
import type { AppointmentEmailKind } from "./appointment-email-template";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type SnapshotRow = {
  jobId: string;
  tenantId: string;
  status: string;
  updatedAt: Date;
  windowStart: Date | null;
  windowEnd: Date | null;
  hasCalendarEvent: boolean;
  calendarReferenceCleared: boolean;
  calendarSettled: boolean;
  originLinkId: string | null;
  conversationId: string | null;
  conversationUpdatedAt: Date | null;
  bindingValid: boolean | null;
  intakeEmail: unknown;
};

function canonicalDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Inactive internal reader, not a controller or send-eligibility authority.
 * Future callers must establish RequestAuthGuard/TenantGuard context first.
 * Never register this result as an operator preview or log the private payload.
 */
export class AppointmentEmailRecipientService {
  constructor(
    private readonly prisma: Pick<PrismaService, "$queryRaw">,
    private readonly cipher: ConversationMemoryCipher,
  ) {}

  async resolve(input: {
    jobId: string;
    kind: AppointmentEmailKind;
    expectedJobUpdatedAt: string;
  }) {
    const ctx = getRequestContext();
    if (
      !ctx?.userId?.trim() ||
      !ctx.tenantId ||
      !UUID.test(ctx.tenantId) ||
      !["owner", "admin"].includes(ctx.role?.trim().toLowerCase() ?? "") ||
      ctx.impersonatedTenantId
    ) {
      throw new ForbiddenException(
        "Email recipient review requires a verified owner or admin tenant context.",
      );
    }
    if (
      !input ||
      typeof input.jobId !== "string" ||
      !UUID.test(input.jobId) ||
      !["confirmed", "rescheduled", "cancelled"].includes(input.kind) ||
      !canonicalDate(input.expectedJobUpdatedAt)
    ) {
      throw new BadRequestException(
        "Email recipient review requires a job, supported event and reviewed version.",
      );
    }
    const tenantId = ctx.tenantId;
    const { jobId, kind, expectedJobUpdatedAt } = input;
    try {
      // One PostgreSQL statement gives a single MVCC snapshot. Cap all origin
      // links before choosing a recipient; do not pick the newest/first email.
      // Only the intakeEmail subfield is selected, never the transcript/root JSON.
      const rows = await this.prisma.$queryRaw<SnapshotRow[]>(Prisma.sql`
        SELECT j."id" AS "jobId", j."tenantId", j."status", j."updatedAt",
          j."serviceWindowStart" AS "windowStart", j."serviceWindowEnd" AS "windowEnd",
          (j."calendarEventId" IS NOT NULL AND length(btrim(j."calendarEventId")) > 0) AS "hasCalendarEvent",
          (j."calendarEventId" IS NULL) AS "calendarReferenceCleared",
          NOT EXISTS (SELECT 1 FROM "CalendarOperation" op
            WHERE op."jobId" = j."id" AND op."tenantId" = j."tenantId" AND op."finishedAt" IS NULL) AS "calendarSettled",
          origin."originLinkId", origin."conversationId", origin."conversationUpdatedAt", origin."bindingValid",
          CASE WHEN origin."bindingValid" THEN origin."intakeEmail" ELSE NULL END AS "intakeEmail"
        FROM "Job" j
        JOIN "TenantOrganization" t ON t."id" = j."tenantId" AND t."status" = 'ACTIVE'
        JOIN "Customer" customer ON customer."id" = j."customerId"
          AND customer."tenantId" = j."customerTenantId" AND customer."tenantId" = j."tenantId"
          AND customer."deletedAt" IS NULL
        LEFT JOIN LATERAL (
          SELECT l."id" AS "originLinkId", c."id" AS "conversationId",
            c."updatedAt" AS "conversationUpdatedAt", c."collectedData" -> 'intakeEmail' AS "intakeEmail",
            (l."tenantId" = j."tenantId" AND l."jobTenantId" = j."tenantId"
              AND l."conversationTenantId" = j."tenantId" AND c."tenantId" = j."tenantId"
              AND c."customerTenantId" = j."tenantId" AND cc."tenantId" = j."tenantId"
              AND c."deletedAt" IS NULL AND cc."deletedAt" IS NULL AND cc."id" IS NOT NULL
              AND j."intakeSessionId" IS NOT NULL AND length(j."intakeSessionId") > 0
              AND jsonb_typeof(c."collectedData") = 'object'
              AND jsonb_typeof(c."collectedData" -> 'sessionId') = 'string'
              AND c."collectedData" ->> 'sessionId' = j."intakeSessionId") AS "bindingValid"
          FROM "ConversationJobLink" l
          LEFT JOIN "Conversation" c ON c."id" = l."conversationId" AND c."tenantId" = l."conversationTenantId"
          LEFT JOIN "Customer" cc ON cc."id" = c."customerId" AND cc."tenantId" = c."customerTenantId"
          WHERE l."jobId" = j."id" AND l."relationType" = 'CREATED_FROM'
          ORDER BY l."id" LIMIT 2
        ) origin ON TRUE
        WHERE j."id" = ${jobId}::uuid AND j."tenantId" = ${tenantId}::uuid AND j."deletedAt" IS NULL
      `);
      const row = rows[0];
      if (!row)
        throw new NotFoundException(
          "Job is unavailable for email recipient review.",
        );
      if (
        row.tenantId.toLowerCase() !== tenantId.toLowerCase() ||
        row.jobId.toLowerCase() !== jobId.toLowerCase()
      )
        throw new Error("Invalid scoped projection");
      if (row.updatedAt.toISOString() !== expectedJobUpdatedAt)
        throw new ConflictException(
          "Job changed. Reload before email recipient review.",
        );
      if (row.calendarSettled !== true)
        throw new ConflictException(
          "Calendar work is unfinished. Email recipient review is on hold.",
        );
      const active = kind !== "cancelled";
      const dates = [row.windowStart, row.windowEnd];
      const validWindow =
        dates.every(
          (date) =>
            date instanceof Date &&
            Number.isFinite(date.getTime()) &&
            date.getUTCSeconds() === 0 &&
            date.getUTCMilliseconds() === 0,
        ) && row.windowEnd!.getTime() > row.windowStart!.getTime();
      if (
        active
          ? row.status !== "ACCEPTED" ||
            row.hasCalendarEvent !== true ||
            !validWindow
          : row.status !== "CANCELLED" ||
            row.hasCalendarEvent !== false ||
            row.calendarReferenceCleared !== true ||
            dates.some((date) => date !== null)
      ) {
        throw new ConflictException(
          "Job lifecycle is incompatible with this email recipient review.",
        );
      }
      if (
        rows.length !== 1 ||
        !row.originLinkId ||
        !row.conversationId ||
        row.bindingValid !== true ||
        !(row.conversationUpdatedAt instanceof Date)
      ) {
        throw new ConflictException("Intake email association needs review.");
      }
      const email = this.retainedEmail(row.intakeEmail);
      return {
        resolution: "recipient_resolved" as const,
        sensitivity: "customer-private" as const,
        snapshotOnly: true as const,
        deliveryAuthorized: false as const,
        tenantId: row.tenantId,
        jobId: row.jobId,
        kind,
        jobUpdatedAt: row.updatedAt.toISOString(),
        recipient: {
          email,
          source: "conversation_intake" as const,
          conversationId: row.conversationId,
          conversationUpdatedAt: row.conversationUpdatedAt.toISOString(),
          ownershipVerified: false as const,
        },
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ConflictException
      )
        throw error;
      // No raw query, decrypted input, ciphertext or diagnostic cause escapes.
      throw new ServiceUnavailableException(
        "Email recipient review is unavailable. Reload before trying again.",
      );
    }
  }

  private retainedEmail(raw: unknown): string {
    const state = object(raw);
    if (!state)
      throw new ConflictException(
        "No captured intake email is available for review.",
      );
    const valid =
      state.version === 1 &&
      (state.askedAt === null || canonicalDate(state.askedAt)) &&
      Object.keys(state).every((key) =>
        ["version", "status", "askedAt", "encryptedEmail"].includes(key),
      );
    if (!valid)
      throw new ConflictException("Captured email state needs review.");
    if (state.status === "asked" || state.status === "declined") {
      if (
        Object.prototype.hasOwnProperty.call(state, "encryptedEmail") ||
        (state.status === "asked" && state.askedAt === null)
      )
        throw new ConflictException("Captured email state needs review.");
      throw new ConflictException(
        "No captured intake email is available for review.",
      );
    }
    const encrypted = state.encryptedEmail;
    if (
      state.status !== "captured" ||
      typeof encrypted !== "string" ||
      encrypted.length > 2048 ||
      !/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/.test(
        encrypted,
      ) ||
      encrypted
        .split(".")
        .slice(1)
        .some(
          (part) =>
            Buffer.from(part, "base64url").toString("base64url") !== part,
        )
    ) {
      throw new ConflictException("Captured email state needs review.");
    }
    const email = this.cipher.decrypt(encrypted);
    // Capture stores a normalized single mailbox, not arbitrary plaintext to parse.
    if (!email || extractIntakeEmail(email) !== email)
      throw new ConflictException("Captured email state needs review.");
    return email;
  }
}
