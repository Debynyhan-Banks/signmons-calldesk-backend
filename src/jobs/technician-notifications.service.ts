import { Injectable, UnauthorizedException } from "@nestjs/common";
import { Prisma, UserRole, UserStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TechnicianLinkService } from "./technician-link.service";

// Existing committed audit events only; never return free-text metadata.
export const TECHNICIAN_NOTIFICATION_ACTIONS = [
  "job.assigned",
  "job.reassigned",
  "job.urgency_escalated",
  "appointment.initial_confirmed",
  "appointment.customer_rescheduled",
  "appointment.customer_cancelled",
  "job.technician_accepted",
  "job.technician_en_route",
  "job.technician_started",
  "job.technician_completed",
] as const;
type Row = { id: string; jobId: string; action: string; createdAt: Date };

@Injectable()
export class TechnicianNotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly links: TechnicianLinkService,
  ) {}

  async list(rawToken: string | undefined) {
    const access = this.links.verify(rawToken);
    const technician = await this.prisma.user.findFirst({
      where: {
        id: access.technicianId,
        tenantId: access.tenantId,
        role: UserRole.TECH,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    if (!technician)
      throw new UnauthorizedException("Technician access is no longer active.");
    const asOf = new Date();
    const since = new Date(asOf.getTime() - 90 * 24 * 60 * 60 * 1000);
    // Join assignment and active-user authority in the same statement as audit reads.
    // entityId is text: cast the trusted UUID column, never arbitrary audit values.
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT a."id", j."id" AS "jobId", a."action", a."createdAt"
      FROM "AuditLog" a
      JOIN "Job" j ON a."entityId" = j."id"::text AND a."tenantId" = j."tenantId"
      JOIN "User" u ON u."id" = j."assignedUserId" AND u."tenantId" = j."assignedUserTenantId"
      WHERE a."tenantId" = ${access.tenantId}::uuid
        AND j."tenantId" = ${access.tenantId}::uuid
        AND j."assignedUserTenantId" = ${access.tenantId}::uuid
        AND u."tenantId" = ${access.tenantId}::uuid
        AND u."id" = ${access.technicianId}::uuid
        AND u."role" = 'TECH' AND u."status" = 'ACTIVE'
        AND j."deletedAt" IS NULL AND a."entityType" = 'Job'
        AND a."action" IN (${Prisma.join([...TECHNICIAN_NOTIFICATION_ACTIONS])})
        AND a."createdAt" >= ${since} AND a."createdAt" <= ${asOf}
      ORDER BY a."createdAt" DESC, a."id" DESC
      LIMIT 101
    `);
    return {
      snapshot: true as const,
      asOf: asOf.toISOString(),
      lookbackDays: 90 as const,
      limit: 100 as const,
      hasMore: rows.length > 100,
      items: rows.slice(0, 100).map((row) => ({
        id: row.id,
        jobId: row.jobId,
        action: row.action,
        occurredAt: row.createdAt.toISOString(),
      })),
    };
  }
}
