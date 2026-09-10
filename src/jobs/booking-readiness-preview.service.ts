import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { getRequestContext } from "../common/context/request-context";
import { PrismaService } from "../prisma/prisma.service";
import { evaluatePaymentGate } from "../payments/payment-gate.policy";
import { IntakeReadinessService } from "./intake-readiness.service";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Inactive diagnostic for CREATED jobs. Never booking or sending authority. */
@Injectable()
export class BookingReadinessPreviewService {
  constructor(private readonly prisma: PrismaService) {}
  async read(input: { jobId: string }) {
    const ctx = getRequestContext();
    if (
      !ctx?.userId?.trim() ||
      !ctx.tenantId ||
      !UUID.test(ctx.tenantId) ||
      ctx.impersonatedTenantId ||
      !["owner", "admin", "dispatcher"].includes(ctx.role?.toLowerCase() ?? "")
    )
      throw new ForbiddenException();
    if (
      !input ||
      typeof input.jobId !== "string" ||
      !UUID.test(input.jobId) ||
      Object.keys(input).join(",") !== "jobId"
    )
      throw new BadRequestException();
    const tenantId = ctx.tenantId;
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const tenant = await tx.tenantOrganization.findFirst({
          where: { id: tenantId, status: "ACTIVE" },
          select: { id: true },
        });
        const job =
          tenant &&
          (await tx.job.findFirst({
            where: { id: input.jobId, tenantId, deletedAt: null },
            include: {
              customer: true,
              propertyAddress: true,
              serviceCategory: true,
              payment: true,
            },
          }));
        if (
          !job ||
          job.customer.tenantId !== tenantId ||
          job.customer.deletedAt ||
          job.propertyAddress.tenantId !== tenantId ||
          job.serviceCategory.tenantId !== tenantId ||
          (job.payment && job.payment.tenantId !== tenantId)
        )
          throw new NotFoundException();
        if (job.status !== "CREATED")
          throw new ConflictException(
            "This preview supports unbooked CREATED jobs only.",
          );
        const summary = new IntakeReadinessService(this.prisma).assessSnapshot(
          job,
        );
        const policy = record(job.policySnapshot),
          admission = record(policy.intakeAdmission);
        const policyKnown =
          typeof policy.depositRequired === "boolean" &&
          typeof policy.serviceFeeRequired === "boolean";
        const payment = evaluatePaymentGate(job.policySnapshot, job.payment);
        const blockers: string[] = summary.readiness.missingFields
          .filter((x) => x !== "paymentStatus")
          .map((x) => "MISSING_" + x);
        if (!policyKnown) blockers.push("PAYMENT_POLICY_UNRESOLVED");
        if (payment.state === "LOCKED") blockers.push(payment.reasonCode);
        if (admission.humanReviewed !== true)
          blockers.push("HUMAN_REVIEW_REQUIRED");
        if (admission.contactVerification !== "VERIFIED")
          blockers.push("CONTACT_NOT_VERIFIED");
        if (admission.addressVerification !== "VERIFIED")
          blockers.push("ADDRESS_NOT_VERIFIED");
        const pending = await tx.calendarOperation.count({
          where: { tenantId, jobId: job.id, finishedAt: null },
        });
        if (pending) blockers.push("CALENDAR_REVIEW_REQUIRED");
        return {
          jobId: job.id,
          jobUpdatedAt: job.updatedAt.toISOString(),
          status: job.status,
          snapshotOnly: true,
          assessment: blockers.length
            ? "BLOCKED"
            : "REQUIRES_BOOKING_VALIDATION",
          blockers,
          payment: {
            state: policyKnown ? payment.state : "UNKNOWN",
            reason: policyKnown
              ? payment.reasonCode
              : "PAYMENT_POLICY_UNRESOLVED",
          },
          confirmation: {
            state: "UNAVAILABLE",
            eligible: false,
            reason: "APPOINTMENT_NOT_FINALIZED",
            preview:
              "No confirmation generated: this job has no finalized booking. Recipient, current consent, mailbox verification and expiry must be checked at the finalized-event boundary.",
          },
          bookingAuthorized: false,
          deliveryAuthorized: false,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
