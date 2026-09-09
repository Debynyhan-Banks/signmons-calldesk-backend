import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { customerEmailPolicy } from "./customer-email-policy";

type Row = {
  tenantId: string;
  jobId: string;
  customerId: string;
  intakeSessionId: string | null;
  jobUpdatedAt: Date;
  windowStart: Date;
  windowEnd: Date;
  calendarEventId: string;
  source: "CALENDAR_ACK" | "CREATE_READBACK";
  calendarOperationId: string | null;
  tenantSettingsUpdatedAt: Date;
  settingsValid: boolean;
  policyPresent: boolean;
  emailPolicy: unknown;
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Transaction-local event recorder. Not delivery admission, a queue or an API.
 * Caller must create the exact finalization audit in this same transaction.
 */
export async function recordAppointmentEmailConfirmation(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; jobId: string; sourceAuditId: string },
) {
  const { tenantId, jobId, sourceAuditId } = input;
  if (
    ![tenantId, jobId, sourceAuditId].every(
      (id) => typeof id === "string" && UUID.test(id),
    )
  )
    throw new ConflictException(
      "Email intent requires a bound finalization receipt.",
    );
  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
    SELECT j."tenantId", j.id AS "jobId", j."customerId", j."intakeSessionId",
      j."updatedAt" AS "jobUpdatedAt", j."serviceWindowStart" AS "windowStart", j."serviceWindowEnd" AS "windowEnd", j."calendarEventId",
      CASE WHEN a."actorType" = 'CUSTOMER' THEN 'CALENDAR_ACK' ELSE 'CREATE_READBACK' END AS source,
      op.id AS "calendarOperationId", t."updatedAt" AS "tenantSettingsUpdatedAt",
      (jsonb_typeof(t.settings) = 'object') AS "settingsValid",
      (t.settings ? 'customerEmailPreferences') AS "policyPresent", t.settings -> 'customerEmailPreferences' AS "emailPolicy"
    FROM "Job" j
    JOIN "TenantOrganization" t ON t.id = j."tenantId" AND t.status = 'ACTIVE'
    JOIN "Customer" c ON c.id = j."customerId" AND c."tenantId" = j."customerTenantId"
      AND c."tenantId" = j."tenantId" AND c."deletedAt" IS NULL
    JOIN "AuditLog" a ON a.id = ${sourceAuditId}::uuid AND a."tenantId" = j."tenantId"
      AND a.xmin = pg_current_xact_id()::xid
      AND a."entityId" = j.id::text AND a."entityType" = 'Job' AND a.action = 'appointment.initial_confirmed'
      AND a.metadata ->> 'finalizedUpdatedAt' = to_char(j."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    JOIN "SmsEnqueueIntent" sms ON sms.id::text = a.metadata ->> 'notificationIntentId'
      AND sms."tenantId" = j."tenantId" AND sms."jobId" = j.id AND sms."templateKey" = 'APPOINTMENT_CONFIRMED'
    LEFT JOIN "CalendarOperation" op ON op.id::text = a.metadata ->> 'calendarOperationId'
      AND op."tenantId" = j."tenantId" AND op."jobId" = j.id AND op.action = 'CREATE'
      AND op.status = 'FINALIZED' AND op."finishedAt" IS NOT NULL AND op."calendarEventId" = j."calendarEventId"
      AND op."desiredWindowStart" = j."serviceWindowStart" AND op."desiredWindowEnd" = j."serviceWindowEnd"
    WHERE j.id = ${jobId}::uuid AND j."tenantId" = ${tenantId}::uuid AND j."deletedAt" IS NULL
      AND j.status = 'ACCEPTED' AND length(btrim(j."calendarEventId")) > 0
      AND j."serviceWindowStart" IS NOT NULL AND j."serviceWindowEnd" > j."serviceWindowStart"
      AND NOT EXISTS (SELECT 1 FROM "CalendarOperation" pending WHERE pending."tenantId" = j."tenantId" AND pending."jobId" = j.id AND pending."finishedAt" IS NULL)
      AND ((a."actorType" = 'CUSTOMER' AND a."actorId" = 'customer:' || j."customerId"::text AND NOT (a.metadata ? 'calendarOperationId'))
        OR (a."actorType" = 'SYSTEM_AI' AND a."actorId" = 'calendar-reconciliation' AND a.metadata ->> 'calendarEvidence' = 'MATCHED_CREATE_READBACK' AND op.id IS NOT NULL))
  `);
  if (rows.length !== 1)
    throw new ConflictException(
      "Email intent requires a current finalized appointment receipt.",
    );
  const row = rows[0];
  const policy = customerEmailPolicy(
    row.settingsValid
      ? row.policyPresent
        ? { customerEmailPreferences: row.emailPolicy }
        : {}
      : null,
  );
  // Explicit projection keeps private provider/settings values out of persisted content.
  const data = {
    tenantId: row.tenantId,
    jobId: row.jobId,
    customerId: row.customerId,
    intakeSessionId: row.intakeSessionId,
    jobUpdatedAt: row.jobUpdatedAt,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    source: row.source,
    calendarOperationId: row.calendarOperationId,
    tenantSettingsUpdatedAt: row.tenantSettingsUpdatedAt,
    sourceAuditId,
    calendarEventHash: createHash("sha256")
      .update(row.calendarEventId)
      .digest("hex"),
    preference:
      policy.source === "invalid"
        ? "INVALID"
        : policy.events.APPOINTMENT_CONFIRMED
          ? "PERMITTED"
          : "BLOCKED",
  };
  await tx.appointmentEmailIntent.createMany({ data, skipDuplicates: true });
  const saved = await tx.appointmentEmailIntent.findUnique({
    where: { sourceAuditId_tenantId: { sourceAuditId, tenantId } },
    select: { id: true, jobId: true },
  });
  if (!saved || saved.jobId !== jobId)
    throw new ConflictException(
      "Email intent identity conflicts with the finalization receipt.",
    );
  return { id: saved.id };
}
