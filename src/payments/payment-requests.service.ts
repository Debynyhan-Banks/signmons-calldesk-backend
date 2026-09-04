import { createHash, randomUUID } from "crypto";
import {
  ConflictException,
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
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
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
