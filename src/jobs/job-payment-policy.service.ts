import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { getRequestContext } from "../common/context/request-context";
import {
  ORGANIZATION_PAYMENT_POLICY,
  profile,
  draft,
  object,
  exact,
  timestamp,
} from "../tenants/organization-payment-policy";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
@Injectable()
export class JobPaymentPolicyService {
  constructor(private readonly prisma: PrismaService) {}
  async apply(input: unknown) {
    const ctx = getRequestContext();
    if (
      !ctx?.userId?.trim() ||
      !ctx.tenantId ||
      !UUID.test(ctx.tenantId) ||
      ctx.impersonatedTenantId ||
      !["owner", "admin"].includes(ctx.role?.trim().toLowerCase() ?? "")
    )
      throw new ForbiddenException();
    const body = object(input);
    if (
      !body ||
      !exact(body, [
        "jobId",
        "expectedUpdatedAt",
        "approvedAt",
        "acknowledged",
      ]) ||
      typeof body.jobId !== "string" ||
      !UUID.test(body.jobId) ||
      !timestamp(body.expectedUpdatedAt) ||
      !timestamp(body.approvedAt) ||
      body.acknowledged !== true
    )
      throw new BadRequestException();
    const tenantId = ctx.tenantId,
      actorId = ctx.userId,
      jobId = body.jobId,
      expected = body.expectedUpdatedAt,
      approvedAt = body.approvedAt;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "TenantOrganization" WHERE id=${tenantId}::uuid FOR SHARE`,
      );
      const tenant = await tx.tenantOrganization.findFirst({
        where: { id: tenantId, status: "ACTIVE" },
        select: { settings: true },
      });
      const approved =
        tenant &&
        profile(object(tenant.settings)?.[ORGANIZATION_PAYMENT_POLICY])
          ?.approved;
      if (
        !approved ||
        approved.approvedAt !== approvedAt ||
        Date.parse(approvedAt) > Date.now()
      )
        throw new ConflictException(
          "Approved payment policy changed or is unavailable. Reload.",
        );
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
        (await tx.calendarOperation.count({ where: { jobId, tenantId } }))
      )
        throw new ConflictException(
          "Job has payment or scheduling activity; policy cannot be attached here.",
        );
      const policy = object(job.policySnapshot),
        pricing = object(job.pricingSnapshot);
      if (
        !policy ||
        !pricing ||
        object(policy.intakeAdmission)?.humanReviewed !== true
      )
        throw new ConflictException("Human-reviewed intake required.");
      const digest = createHash("sha256")
        .update(JSON.stringify(approved))
        .digest("hex");
      const prior = object(policy.paymentPolicyBinding);
      const terms = approved.draft;
      const receipt = (updatedAt: string) => ({
        jobId,
        updatedAt,
        approvedAt,
        policyBound: true,
        bookingAuthorized: false,
        deliveryAuthorized: false,
        paymentInitiated: false,
      });
      if (prior) {
        if (
          prior.version === 1 &&
          JSON.stringify(draft(prior.snapshot)) === JSON.stringify(terms) &&
          policy.depositRequired === terms.depositRequired &&
          policy.serviceFeeRequired === terms.serviceFeeRequired &&
          policy.paymentGateMode === "fail_closed" &&
          policy.webhookValidationRequired === true &&
          pricing.currency === "usd" &&
          pricing.serviceFeeAmountCents === (terms.serviceFeeCents ?? 0) &&
          pricing.depositAmountCents ===
            (terms.depositPolicy.kind === "fixed"
              ? terms.depositPolicy.amountCents
              : 0) &&
          prior.actorId === actorId &&
          prior.expectedUpdatedAt === expected &&
          prior.approvedAt === approvedAt &&
          prior.digest === digest &&
          prior.updatedAt === job.updatedAt.toISOString()
        )
          return receipt(job.updatedAt.toISOString());
        throw new ConflictException(
          "Job already has a reviewed policy; replacement is not supported.",
        );
      }
      if (
        job.updatedAt.toISOString() !== expected ||
        Object.keys(pricing).length ||
        [
          "depositRequired",
          "serviceFeeRequired",
          "paymentGateMode",
          "paymentGateException",
        ].some((k) => k in policy)
      )
        throw new ConflictException(
          "Job changed or already has payment terms. Reload for review.",
        );
      const p = approved.draft,
        updatedAt = new Date(Math.max(Date.now(), job.updatedAt.getTime() + 1));
      const next = {
        ...policy,
        depositRequired: p.depositRequired,
        serviceFeeRequired: p.serviceFeeRequired,
        paymentGateMode: p.paymentGateMode,
        webhookValidationRequired: true,
        paymentPolicyBinding: {
          version: 1,
          actorId,
          approvedAt,
          digest,
          expectedUpdatedAt: expected,
          updatedAt: updatedAt.toISOString(),
          snapshot: p,
        },
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
          policySnapshot: next as unknown as Prisma.InputJsonValue,
          pricingSnapshot: {
            currency: "usd",
            serviceFeeAmountCents: p.serviceFeeCents ?? 0,
            depositAmountCents:
              p.depositPolicy.kind === "fixed"
                ? p.depositPolicy.amountCents
                : 0,
          },
          updatedAt,
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
          action: "job.payment_policy_bound",
          metadata: {
            version: 1,
            approvedAt,
            digest,
            expectedUpdatedAt: expected,
            updatedAt: updatedAt.toISOString(),
          },
        },
      });
      return receipt(updatedAt.toISOString());
    });
  }
}
