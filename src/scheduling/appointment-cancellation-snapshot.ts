import { ConflictException } from "@nestjs/common";
import { Job, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

/** Read canonical pre-clear values; caller must CAS the claim in this transaction.
 * A retained claim (including one subsequently restored) is never finalization proof.
 */
export async function captureCancellationSnapshot(
  tx: Prisma.TransactionClient,
  job: Job,
  claimedUpdatedAt: Date,
) {
  const rows = await tx.$queryRaw<
    (Pick<Job, "customerId" | "intakeSessionId"> & {
      windowStart: Date;
      windowEnd: Date;
      calendarEventId: string;
    })[]
  >(Prisma.sql`SELECT j."customerId", j."intakeSessionId",
      j."serviceWindowStart" AS "windowStart", j."serviceWindowEnd" AS "windowEnd", j."calendarEventId"
    FROM "Job" j
    JOIN "TenantOrganization" t ON t.id = j."tenantId" AND t.status = 'ACTIVE'
    JOIN "Customer" c ON c.id = j."customerId" AND c."tenantId" = j."customerTenantId"
      AND c."tenantId" = j."tenantId" AND c."deletedAt" IS NULL
    WHERE j.id = ${job.id}::uuid AND j."tenantId" = ${job.tenantId}::uuid
      AND j."updatedAt" = ${job.updatedAt} AND j."deletedAt" IS NULL AND j.status = 'ACCEPTED'
      AND length(btrim(j."calendarEventId")) > 0 AND j."serviceWindowEnd" > j."serviceWindowStart"
      AND NOT EXISTS (SELECT 1 FROM "CalendarOperation" op WHERE op."tenantId" = j."tenantId" AND op."jobId" = j.id AND op."finishedAt" IS NULL)
  `);
  if (rows.length !== 1 || claimedUpdatedAt <= job.updatedAt)
    throw new ConflictException(
      "Appointment changed before cancellation snapshot.",
    );
  const row = rows[0];
  await tx.appointmentCancellationSnapshot.create({
    data: {
      tenantId: job.tenantId,
      jobId: job.id,
      claimedUpdatedAt,
      previousUpdatedAt: job.updatedAt,
      customerId: row.customerId,
      intakeSessionId: row.intakeSessionId,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      calendarEventHash: createHash("sha256")
        .update(row.calendarEventId)
        .digest("hex"),
    },
  });
}
