import { createHash, randomUUID } from "crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  AuditActorType,
  JobStatus,
  PaymentStatus,
  Prisma,
  RefundStatus,
  SubscriptionStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  unfinishedCalendarOperations,
  noUnfinishedCalendarOperations,
  requireCalendarOperationSettled,
} from "../scheduling/calendar-operation-guard";
import type { PaymentCheckoutProvider } from "./interfaces/payment-checkout-provider.interface";
import { PAYMENT_CHECKOUT_PROVIDER } from "./payments.constants";

type PaymentRequirement = {
  kind: "DEPOSIT" | "SERVICE_FEE" | "DEPOSIT_AND_SERVICE_FEE";
  label: string;
  amountTotalCents: number;
  currency: string;
};

type PaymentTracking = {
  paymentRequestId: string | null;
  status: PaymentStatus | "NOT_REQUESTED";
  amountTotalCents: number | null;
  currency: string | null;
  requestedAt: string | null;
  checkoutExpiresAt: string | null;
  requestActive: boolean;
};

type PaymentEventVisibility = {
  id: string;
  type: string;
  status: string;
  receivedAt: string;
  processedAt: string | null;
};

const RETRYABLE_PAYMENT_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.FAILED,
  PaymentStatus.CANCELED,
  PaymentStatus.REFUNDED,
]);
const REQUEST_RESERVATION_TIMEOUT_MS = 5 * 60 * 1000;

@Injectable()
export class PaymentRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_CHECKOUT_PROVIDER)
    private readonly checkoutProvider: PaymentCheckoutProvider,
  ) {}

  async get(tenantId: string, jobId: string): Promise<PaymentTracking> {
    const job = await this.prisma.job.findFirst({
      where: { tenantId, id: jobId, deletedAt: null },
      select: { payment: true },
    });
    if (!job) throw new NotFoundException("Job was not found.");
    return this.tracking(job.payment);
  }

  async events(
    tenantId: string,
    jobId: string,
  ): Promise<PaymentEventVisibility[]> {
    const job = await this.prisma.job.findFirst({
      where: { tenantId, id: jobId, deletedAt: null },
      select: { payment: { select: { id: true } } },
    });
    if (!job) throw new NotFoundException("Job was not found.");
    if (!job.payment) return [];
    const events = await this.prisma.stripeEvent.findMany({
      where: {
        tenantId,
        payload: { path: ["paymentId"], equals: job.payment.id },
      },
      orderBy: { receivedAt: "desc" },
      take: 20,
      select: {
        id: true,
        type: true,
        processingStatus: true,
        receivedAt: true,
        processedAt: true,
      },
    });
    return events.map((event) => ({
      id: event.id,
      type: event.type,
      status: event.processingStatus,
      receivedAt: event.receivedAt.toISOString(),
      processedAt: event.processedAt?.toISOString() ?? null,
    }));
  }

  async governException(input: {
    tenantId: string;
    jobId: string;
    actorId: string;
    traceId: string;
    action: "APPROVE" | "REVOKE";
    reason: string;
    expectedJobUpdatedAt: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const job = await transaction.job.findFirst({
        where: { tenantId: input.tenantId, id: input.jobId, deletedAt: null },
        select: {
          id: true,
          status: true,
          updatedAt: true,
          policySnapshot: true,
          calendarOperations: unfinishedCalendarOperations,
          payment: { select: { status: true } },
        },
      });
      if (!job) throw new NotFoundException("Job was not found.");
      requireCalendarOperationSettled(job);
      if (
        job.status === JobStatus.COMPLETED ||
        job.status === JobStatus.CANCELLED
      ) {
        throw new ConflictException("A closed job cannot be overridden.");
      }
      if (
        job.updatedAt.getTime() !==
        new Date(input.expectedJobUpdatedAt).getTime()
      ) {
        throw new ConflictException(
          "Job changed after it was loaded. Refresh before changing the payment exception.",
        );
      }
      const snapshot = this.record(job.policySnapshot) ?? {};
      const existing = this.record(snapshot.paymentGateException);
      const required =
        snapshot.depositRequired === true ||
        snapshot.serviceFeeRequired === true;
      if (!required) {
        throw new ConflictException("This job does not have a payment gate.");
      }
      if (job.payment?.status === PaymentStatus.SUCCEEDED) {
        throw new ConflictException(
          "Verified payment already satisfies this job's payment gate.",
        );
      }
      if (input.action === "APPROVE") {
        if (snapshot.paymentGateMode !== "manual_override") {
          throw new ForbiddenException(
            "This job's governed policy does not allow a manual payment exception.",
          );
        }
        const entitlement = await transaction.tenantSubscription.findFirst({
          where: {
            tenantId: input.tenantId,
            status: {
              in: [SubscriptionStatus.TRIALING, SubscriptionStatus.ACTIVE],
            },
            currentPeriodStart: { lte: new Date() },
            currentPeriodEnd: { gt: new Date() },
          },
          orderBy: { currentPeriodEnd: "desc" },
          select: { planId: true },
        });
        if (!this.advancedPaymentPlan(entitlement?.planId)) {
          throw new ForbiddenException(
            "Payment exception approval requires an active Growth or higher entitlement.",
          );
        }
      }
      const active = input.action === "APPROVE";
      if (existing?.active === active) {
        throw new ConflictException(
          active
            ? "A payment exception is already active."
            : "No active payment exception exists.",
        );
      }
      const changedAt = new Date(
        Math.max(Date.now(), job.updatedAt.getTime() + 1),
      );
      const updated = await transaction.job.updateMany({
        where: {
          tenantId: input.tenantId,
          id: input.jobId,
          updatedAt: job.updatedAt,
          status: job.status,
          calendarOperations: noUnfinishedCalendarOperations,
          deletedAt: null,
        },
        data: {
          updatedAt: changedAt,
          policySnapshot: {
            ...snapshot,
            paymentGateException: active
              ? {
                  active: true,
                  reason: input.reason,
                  approvedAt: changedAt.toISOString(),
                  approvedBy: input.actorId,
                }
              : {
                  active: false,
                  reason: input.reason,
                  revokedAt: changedAt.toISOString(),
                  revokedBy: input.actorId,
                },
          } satisfies Prisma.InputJsonValue,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException(
          "Job changed while the payment exception was being saved.",
        );
      }
      const audit = await transaction.auditLog.create({
        data: {
          tenantId: input.tenantId,
          action: active
            ? "payment.gate_exception_approved"
            : "payment.gate_exception_revoked",
          actorType: AuditActorType.USER,
          actorUserId: input.actorId,
          actorUserTenantId: input.tenantId,
          actorId: input.actorId,
          entityType: "Job",
          entityId: input.jobId,
          traceId: input.traceId,
          metadata: {
            reason: input.reason,
            action: input.action,
            previousPaymentStatus: job.payment?.status ?? "NOT_REQUESTED",
            changedAt: changedAt.toISOString(),
          } satisfies Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return {
        changed: true,
        jobId: input.jobId,
        exception: {
          active,
          reason: input.reason,
          changedAt: changedAt.toISOString(),
          auditId: audit.id,
        },
      };
    });
  }

  async recover(tenantId: string, jobId: string) {
    const job = await this.prisma.job.findFirst({
      where: { tenantId, id: jobId, deletedAt: null },
      select: {
        id: true,
        tenant: {
          select: { stripeConnectAccountId: true, chargesEnabled: true },
        },
        payment: true,
      },
    });
    if (!job) throw new NotFoundException("Job was not found.");
    const payment = job.payment;
    if (
      !payment ||
      payment.status !== PaymentStatus.PENDING ||
      !payment.stripeCheckoutSessionId ||
      !payment.destinationAccountId ||
      !payment.checkoutExpiresAt ||
      payment.checkoutExpiresAt.getTime() <= Date.now()
    ) {
      throw new ConflictException(
        "This payment link is no longer active. Contact the service company for a new request.",
      );
    }
    if (
      !job.tenant.chargesEnabled ||
      job.tenant.stripeConnectAccountId !== payment.destinationAccountId
    ) {
      throw new ServiceUnavailableException(
        "The contractor payment account is not ready to accept charges.",
      );
    }
    const recovered = await this.checkoutProvider.recoverCheckout({
      connectedAccountId: payment.destinationAccountId,
      sessionId: payment.stripeCheckoutSessionId,
    });
    if (!recovered) {
      throw new ConflictException(
        "This payment link is no longer active. Contact the service company for a new request.",
      );
    }
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        action: "payment.checkout_recovered",
        actorType: AuditActorType.CUSTOMER,
        actorId: "secure-link-customer",
        entityType: "Payment",
        entityId: payment.id,
        traceId: randomUUID(),
        metadata: {
          jobId: job.id,
          status: payment.status,
          checkoutExpiresAt: recovered.expiresAt.toISOString(),
        },
      },
    });
    return {
      status: "payment_checkout" as const,
      checkoutUrl: recovered.checkoutUrl,
      checkoutExpiresAt: recovered.expiresAt.toISOString(),
    };
  }

  async create(input: {
    tenantId: string;
    jobId: string;
    actorId: string;
    traceId: string;
    idempotencyKey: string;
    expectedJobUpdatedAt: string;
  }): Promise<PaymentTracking & { checkoutUrl: string }> {
    const job = await this.prisma.job.findFirst({
      where: { tenantId: input.tenantId, id: input.jobId, deletedAt: null },
      select: {
        id: true,
        status: true,
        updatedAt: true,
        policySnapshot: true,
        pricingSnapshot: true,
        tenant: {
          select: {
            stripeConnectAccountId: true,
            chargesEnabled: true,
          },
        },
        payment: true,
      },
    });
    if (!job) throw new NotFoundException("Job was not found.");
    if (
      job.updatedAt.getTime() !== new Date(input.expectedJobUpdatedAt).getTime()
    ) {
      throw new ConflictException(
        "Job changed after it was loaded. Refresh before requesting payment.",
      );
    }
    if (
      job.status === JobStatus.COMPLETED ||
      job.status === JobStatus.CANCELLED
    ) {
      throw new ConflictException(
        "Payment cannot be requested for a closed job.",
      );
    }
    if (!job.tenant.stripeConnectAccountId || !job.tenant.chargesEnabled) {
      throw new ServiceUnavailableException(
        "The contractor payment account is not ready to accept charges.",
      );
    }

    const requirement = this.requirement(
      job.policySnapshot,
      job.pricingSnapshot,
    );
    const requestKeyHash = createHash("sha256")
      .update(input.idempotencyKey)
      .digest("hex");
    const paymentId = job.payment?.id ?? randomUUID();
    const sameRequest = job.payment?.requestKeyHash === requestKeyHash;
    const replay =
      sameRequest &&
      job.payment?.status === PaymentStatus.PENDING &&
      Boolean(job.payment?.stripeCheckoutSessionId) &&
      Boolean(
        job.payment?.checkoutExpiresAt &&
          job.payment.checkoutExpiresAt.getTime() > Date.now(),
      );

    if (job.payment?.status === PaymentStatus.SUCCEEDED) {
      throw new ConflictException("Required payment has already succeeded.");
    }
    if (sameRequest && job.payment?.stripeCheckoutSessionId && !replay) {
      throw new ConflictException(
        "The payment link is not active. Create a new request key to retry.",
      );
    }
    if (
      job.payment?.status === PaymentStatus.PENDING &&
      !sameRequest &&
      !this.expiredOrAbandoned(job.payment)
    ) {
      throw new ConflictException(
        "An active payment request already exists for this job.",
      );
    }

    if (!replay) {
      await this.reserveRequest({
        tenantId: input.tenantId,
        jobId: input.jobId,
        paymentId,
        requestKeyHash,
        connectedAccountId: job.tenant.stripeConnectAccountId,
        requirement,
        existingPayment: job.payment,
      });
    }

    const connectedAccountId =
      job.payment?.requestKeyHash === requestKeyHash &&
      job.payment.destinationAccountId
        ? job.payment.destinationAccountId
        : job.tenant.stripeConnectAccountId;

    let checkout;
    try {
      checkout = await this.checkoutProvider.createCheckout({
        tenantId: input.tenantId,
        jobId: input.jobId,
        paymentRequestId: paymentId,
        connectedAccountId,
        idempotencyKey: input.idempotencyKey,
        amountTotalCents: requirement.amountTotalCents,
        currency: requirement.currency,
        label: requirement.label,
      });
    } catch (error) {
      if (!replay) {
        await this.recordFailure({
          tenantId: input.tenantId,
          jobId: input.jobId,
          paymentId,
          actorId: input.actorId,
          traceId: input.traceId,
          requestKeyHash,
          requirement,
        });
      }
      throw error;
    }

    const persisted = await this.recordCreated({
      tenantId: input.tenantId,
      jobId: input.jobId,
      paymentId,
      actorId: input.actorId,
      traceId: input.traceId,
      requestKeyHash,
      requirement,
      checkout,
    });
    return { ...this.tracking(persisted), checkoutUrl: checkout.checkoutUrl };
  }

  private async reserveRequest(input: {
    tenantId: string;
    jobId: string;
    paymentId: string;
    requestKeyHash: string;
    connectedAccountId: string;
    requirement: PaymentRequirement;
    existingPayment: {
      id: string;
      status: PaymentStatus;
      updatedAt: Date;
      requestedAt: Date | null;
      checkoutExpiresAt: Date | null;
    } | null;
  }): Promise<void> {
    if (!input.existingPayment) {
      try {
        await this.prisma.payment.create({
          data: {
            id: input.paymentId,
            tenantId: input.tenantId,
            jobId: input.jobId,
            jobTenantId: input.tenantId,
            status: PaymentStatus.PENDING,
            requestKeyHash: input.requestKeyHash,
            requestedAt: new Date(),
            destinationAccountId: input.connectedAccountId,
            amountTotalCents: input.requirement.amountTotalCents,
            applicationFeeAmountCents: 0,
            currency: input.requirement.currency,
          },
        });
        return;
      } catch (error) {
        if (this.prismaCode(error) === "P2002") {
          throw new ConflictException(
            "A payment request is already being created for this job.",
          );
        }
        throw error;
      }
    }

    if (
      !RETRYABLE_PAYMENT_STATUSES.has(input.existingPayment.status) &&
      !this.expiredOrAbandoned(input.existingPayment)
    ) {
      throw new ConflictException(
        "An active payment request already exists for this job.",
      );
    }
    const updated = await this.prisma.payment.updateMany({
      where: {
        tenantId: input.tenantId,
        id: input.paymentId,
        updatedAt: input.existingPayment.updatedAt,
        OR: [
          { status: { in: [...RETRYABLE_PAYMENT_STATUSES] } },
          {
            status: PaymentStatus.PENDING,
            checkoutExpiresAt: { lte: new Date() },
          },
          {
            status: PaymentStatus.PENDING,
            checkoutExpiresAt: null,
            requestedAt: {
              lte: new Date(Date.now() - REQUEST_RESERVATION_TIMEOUT_MS),
            },
          },
        ],
      },
      data: {
        status: PaymentStatus.PENDING,
        requestKeyHash: input.requestKeyHash,
        requestedAt: new Date(),
        checkoutExpiresAt: null,
        stripeCheckoutSessionId: null,
        stripePaymentIntentId: null,
        destinationAccountId: input.connectedAccountId,
        amountTotalCents: input.requirement.amountTotalCents,
        applicationFeeAmountCents: 0,
        currency: input.requirement.currency,
        refundStatus: RefundStatus.NONE,
        refundAmountCents: null,
        stripeRefundId: null,
        refundReason: null,
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException(
        "Payment state changed while the request was being created.",
      );
    }
  }

  private async recordCreated(input: {
    tenantId: string;
    jobId: string;
    paymentId: string;
    actorId: string;
    traceId: string;
    requestKeyHash: string;
    requirement: PaymentRequirement;
    checkout: {
      sessionId: string;
      paymentIntentId: string | null;
      expiresAt: Date;
    };
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.payment.updateMany({
        where: {
          tenantId: input.tenantId,
          id: input.paymentId,
          requestKeyHash: input.requestKeyHash,
          stripeCheckoutSessionId: null,
        },
        data: {
          stripeCheckoutSessionId: input.checkout.sessionId,
          stripePaymentIntentId: input.checkout.paymentIntentId,
          checkoutExpiresAt: input.checkout.expiresAt,
        },
      });
      if (updated.count === 1) {
        await transaction.auditLog.create({
          data: {
            tenantId: input.tenantId,
            action: "payment.request_created",
            actorType: AuditActorType.USER,
            actorUserId: input.actorId,
            actorUserTenantId: input.tenantId,
            actorId: input.actorId,
            entityType: "Payment",
            entityId: input.paymentId,
            traceId: input.traceId,
            metadata: {
              jobId: input.jobId,
              requestKind: input.requirement.kind,
              amountTotalCents: input.requirement.amountTotalCents,
              currency: input.requirement.currency,
              status: PaymentStatus.PENDING,
              checkoutExpiresAt: input.checkout.expiresAt.toISOString(),
            },
          },
        });
      }
      const payment = await transaction.payment.findFirst({
        where: { tenantId: input.tenantId, id: input.paymentId },
      });
      if (!payment)
        throw new NotFoundException("Payment request was not found.");
      return payment;
    });
  }

  private async recordFailure(input: {
    tenantId: string;
    jobId: string;
    paymentId: string;
    actorId: string;
    traceId: string;
    requestKeyHash: string;
    requirement: PaymentRequirement;
  }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.payment.updateMany({
        where: {
          tenantId: input.tenantId,
          id: input.paymentId,
          requestKeyHash: input.requestKeyHash,
          stripeCheckoutSessionId: null,
        },
        data: { status: PaymentStatus.FAILED },
      });
      if (updated.count !== 1) return;
      await transaction.auditLog.create({
        data: {
          tenantId: input.tenantId,
          action: "payment.request_failed",
          actorType: AuditActorType.USER,
          actorUserId: input.actorId,
          actorUserTenantId: input.tenantId,
          actorId: input.actorId,
          entityType: "Payment",
          entityId: input.paymentId,
          traceId: input.traceId,
          metadata: {
            jobId: input.jobId,
            requestKind: input.requirement.kind,
            amountTotalCents: input.requirement.amountTotalCents,
            currency: input.requirement.currency,
            status: PaymentStatus.FAILED,
            reasonCode: "CHECKOUT_PROVIDER_UNAVAILABLE",
          },
        },
      });
    });
  }

  private requirement(
    policyValue: unknown,
    pricingValue: unknown,
  ): PaymentRequirement {
    const policy = this.record(policyValue);
    const pricing = this.record(pricingValue);
    const depositRequired = policy?.depositRequired === true;
    const serviceFeeRequired = policy?.serviceFeeRequired === true;
    if (!depositRequired && !serviceFeeRequired) {
      throw new ConflictException(
        "This job does not require payment before dispatch.",
      );
    }

    const depositAmount = depositRequired
      ? this.money(pricing?.depositAmountCents, "depositAmountCents")
      : 0;
    const serviceFeeAmount = serviceFeeRequired
      ? this.money(pricing?.serviceFeeAmountCents, "serviceFeeAmountCents")
      : 0;
    const currency =
      typeof pricing?.currency === "string" &&
      /^[A-Za-z]{3}$/.test(pricing.currency)
        ? pricing.currency.toLowerCase()
        : null;
    if (!currency) {
      throw new UnprocessableEntityException(
        "Job pricing does not define a valid payment currency.",
      );
    }

    if (depositRequired && serviceFeeRequired) {
      return {
        kind: "DEPOSIT_AND_SERVICE_FEE",
        label: "Required service deposit and fee",
        amountTotalCents: depositAmount + serviceFeeAmount,
        currency,
      };
    }
    return depositRequired
      ? {
          kind: "DEPOSIT",
          label: "Required service deposit",
          amountTotalCents: depositAmount,
          currency,
        }
      : {
          kind: "SERVICE_FEE",
          label: "Required service fee",
          amountTotalCents: serviceFeeAmount,
          currency,
        };
  }

  private advancedPaymentPlan(planId?: string): boolean {
    return new Set(["growth", "pro", "enterprise"]).has(
      planId?.trim().toLowerCase() ?? "",
    );
  }

  private money(value: unknown, field: string): number {
    if (
      !Number.isInteger(value) ||
      Number(value) <= 0 ||
      Number(value) > 100_000_000
    ) {
      throw new UnprocessableEntityException(
        `Job pricing does not define a valid ${field}.`,
      );
    }
    return Number(value);
  }

  private tracking(
    payment: {
      id: string;
      status: PaymentStatus;
      amountTotalCents: number;
      currency: string;
      requestedAt: Date | null;
      checkoutExpiresAt: Date | null;
    } | null,
  ): PaymentTracking {
    if (!payment) {
      return {
        paymentRequestId: null,
        status: "NOT_REQUESTED",
        amountTotalCents: null,
        currency: null,
        requestedAt: null,
        checkoutExpiresAt: null,
        requestActive: false,
      };
    }
    return {
      paymentRequestId: payment.id,
      status: payment.status,
      amountTotalCents: payment.amountTotalCents,
      currency: payment.currency,
      requestedAt: payment.requestedAt?.toISOString() ?? null,
      checkoutExpiresAt: payment.checkoutExpiresAt?.toISOString() ?? null,
      requestActive:
        payment.status === PaymentStatus.PENDING &&
        Boolean(
          payment.checkoutExpiresAt &&
            payment.checkoutExpiresAt.getTime() > Date.now(),
        ),
    };
  }

  private record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private expiredOrAbandoned(payment: {
    status: PaymentStatus;
    requestedAt: Date | null;
    checkoutExpiresAt: Date | null;
  }): boolean {
    if (payment.status !== PaymentStatus.PENDING) return false;
    if (payment.checkoutExpiresAt) {
      return payment.checkoutExpiresAt.getTime() <= Date.now();
    }
    return Boolean(
      payment.requestedAt &&
        payment.requestedAt.getTime() <=
          Date.now() - REQUEST_RESERVATION_TIMEOUT_MS,
    );
  }

  private prismaCode(error: unknown): string | undefined {
    return error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : undefined;
  }
}
