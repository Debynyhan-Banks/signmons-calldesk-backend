import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { getRequestContext } from "../common/context/request-context";
import { PrismaService } from "../prisma/prisma.service";
import { exact, object, timestamp } from "../tenants/organization-profile";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Local reviewed customer preference, not an availability or booking command. */
@Injectable()
export class PreferredWindowReviewService {
  constructor(private readonly prisma: PrismaService) {}
  async save(input: unknown) {
    const ctx = getRequestContext();
    if (
      !ctx?.userId?.trim() ||
      !ctx.tenantId ||
      !UUID.test(ctx.tenantId) ||
      ctx.impersonatedTenantId ||
      !["owner", "admin", "dispatcher"].includes(
        ctx.role?.trim().toLowerCase() ?? "",
      )
    )
      throw new ForbiddenException();
    const body = object(input);
    if (
      !body ||
      !exact(body, [
        "jobId",
        "expectedUpdatedAt",
        "preference",
        "acknowledged",
      ]) ||
      typeof body.jobId !== "string" ||
      !UUID.test(body.jobId) ||
      !timestamp(body.expectedUpdatedAt) ||
      body.acknowledged !== true ||
      typeof body.preference !== "string" ||
      body.preference !== body.preference.trim() ||
      !body.preference ||
      body.preference.length > 500 ||
      /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(body.preference) ||
      ["unknown", "not provided"].includes(body.preference.toLowerCase())
    )
      throw new BadRequestException(
        "Review a plain-text customer preference of 1–500 characters and the exact job version.",
      );
    const tenantId = ctx.tenantId,
      actorId = ctx.userId,
      jobId = body.jobId,
      expected = body.expectedUpdatedAt,
      preference = body.preference;
    const digest = createHash("sha256")
      .update(
        JSON.stringify({ tenantId, actorId, jobId, expected, preference }),
      )
      .digest("hex");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "TenantOrganization" WHERE id=${tenantId}::uuid FOR SHARE`,
      );
      if (
        !(await tx.tenantOrganization.findFirst({
          where: { id: tenantId, status: "ACTIVE" },
          select: { id: true },
        }))
      )
        throw new NotFoundException();
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "Job" WHERE id=${jobId}::uuid AND "tenantId"=${tenantId}::uuid FOR UPDATE`,
      );
      const job = await tx.job.findFirst({
        where: { id: jobId, tenantId, deletedAt: null },
        include: { payment: true },
      });
      if (!job) throw new NotFoundException();
      if (
        job.status !== "CREATED" ||
        job.payment ||
        job.calendarEventId ||
        job.serviceWindowStart ||
        job.serviceWindowEnd ||
        (await tx.calendarOperation.count({ where: { tenantId, jobId } }))
      )
        throw new ConflictException(
          "Job has payment or scheduling activity. Use the appropriate reviewed workflow.",
        );
      const policy = object(job.policySnapshot);
      if (!policy || object(policy.intakeAdmission)?.humanReviewed !== true)
        throw new ConflictException("Human-reviewed intake required.");
      const prior = object(policy.preferredWindowReview);
      const receipt = (updatedAt: string) => ({
        jobId,
        updatedAt,
        preference,
        source: "CUSTOMER_STATED_OPERATOR_REVIEW",
        availabilityChecked: false,
        bookingAuthorized: false,
        deliveryAuthorized: false,
      });
      if (
        prior?.version === 1 &&
        prior.actorId === actorId &&
        prior.digest === digest &&
        prior.expectedUpdatedAt === expected &&
        prior.updatedAt === job.updatedAt.toISOString() &&
        job.preferredTimeText === preference &&
        job.preferredWindowLabel === null
      )
        return receipt(job.updatedAt.toISOString());
      if (job.updatedAt.toISOString() !== expected)
        throw new ConflictException(
          "Job changed. Reload and review before saving.",
        );
      const updatedAt = new Date(
        Math.max(Date.now(), job.updatedAt.getTime() + 1),
      );
      const review = {
        version: 1,
        actorId,
        digest,
        expectedUpdatedAt: expected,
        updatedAt: updatedAt.toISOString(),
        source: "CUSTOMER_STATED_OPERATOR_REVIEW",
        availabilityChecked: false,
      };
      const result = await tx.job.updateMany({
        where: {
          id: jobId,
          tenantId,
          status: "CREATED",
          deletedAt: null,
          updatedAt: new Date(expected),
        },
        data: {
          preferredTimeText: preference,
          preferredWindowLabel: null,
          updatedAt,
          policySnapshot: {
            ...policy,
            preferredWindowReview: review,
          } as Prisma.InputJsonValue,
        },
      });
      if (result.count !== 1) throw new ConflictException("Job changed.");
      await tx.auditLog.create({
        data: {
          tenantId,
          actorType: "USER",
          actorId,
          entityType: "Job",
          entityId: jobId,
          action: "job.preferred_window_reviewed",
          metadata: review,
        },
      });
      return receipt(updatedAt.toISOString());
    });
  }
}
