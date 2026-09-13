import { createHash } from "crypto";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { JobStatus, PaymentStatus, RefundStatus } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { PaymentCheckoutProvider } from "./interfaces/payment-checkout-provider.interface";
import { PaymentRequestsService } from "./payment-requests.service";

const tenantId = "10000000-0000-4000-8000-000000000001";
const jobId = "20000000-0000-4000-8000-000000000002";
const actorId = "30000000-0000-4000-8000-000000000003";
const traceId = "40000000-0000-4000-8000-000000000004";
const idempotencyKey = "50000000-0000-4000-8000-000000000005";
const updatedAt = new Date("2026-09-04T12:00:00.000Z");
const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

describe("PaymentRequestsService", () => {
  const transaction = {
    job: { findFirst: jest.fn(), updateMany: jest.fn() },
    tenantSubscription: { findFirst: jest.fn() },
    payment: {
      updateMany: jest.fn(),
      findFirst: jest.fn(),
    },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    job: { findFirst: jest.fn() },
    payment: {
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    stripeEvent: { findMany: jest.fn() },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn((callback: (client: typeof transaction) => unknown) =>
      Promise.resolve(callback(transaction)),
    ),
  };
  const provider: jest.Mocked<PaymentCheckoutProvider> = {
    createCheckout: jest.fn(),
    recoverCheckout: jest.fn(),
  };
  const service = new PaymentRequestsService(
    prisma as unknown as PrismaService,
    provider,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.payment.create.mockResolvedValue({ id: "payment-1" });
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    transaction.payment.updateMany.mockResolvedValue({ count: 1 });
    transaction.job.updateMany.mockResolvedValue({ count: 1 });
    transaction.tenantSubscription.findFirst.mockResolvedValue({
      planId: "growth",
    });
    transaction.auditLog.create.mockResolvedValue({ id: "audit-1" });
    transaction.payment.findFirst.mockResolvedValue(paymentRecord());
    provider.createCheckout.mockResolvedValue({
      sessionId: "cs_test_private",
      paymentIntentId: "pi_test_private",
      checkoutUrl: "https://checkout.stripe.test/session",
      expiresAt,
    });
    provider.recoverCheckout.mockResolvedValue({
      checkoutUrl: "https://checkout.stripe.com/c/pay/test",
      expiresAt,
    });
    prisma.stripeEvent.findMany.mockResolvedValue([]);
  });

  it("creates an idempotent direct-account deposit request from trusted snapshots", async () => {
    prisma.job.findFirst.mockResolvedValue(jobRecord());

    const result = await service.create(createInput());

    expect(provider.createCheckout).toHaveBeenCalledWith({
      tenantId,
      jobId,
      paymentRequestId: expect.any(String),
      connectedAccountId: "acct_connected",
      idempotencyKey,
      amountTotalCents: 12500,
      currency: "usd",
      label: "Required service deposit",
    });
    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId,
        jobId,
        jobTenantId: tenantId,
        status: PaymentStatus.PENDING,
        requestKeyHash: createHash("sha256")
          .update(idempotencyKey)
          .digest("hex"),
        amountTotalCents: 12500,
        applicationFeeAmountCents: 0,
        currency: "usd",
      }),
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId,
        action: "payment.request_created",
        actorUserId: actorId,
        actorUserTenantId: tenantId,
        entityType: "Payment",
        traceId,
        metadata: {
          jobId,
          requestKind: "DEPOSIT",
          amountTotalCents: 12500,
          currency: "usd",
          status: PaymentStatus.PENDING,
          checkoutExpiresAt: expiresAt.toISOString(),
        },
      }),
    });
    const auditPayload = JSON.stringify(transaction.auditLog.create.mock.calls);
    expect(auditPayload).not.toContain("cs_test_private");
    expect(auditPayload).not.toContain("pi_test_private");
    expect(result).toEqual({
      paymentRequestId: "payment-1",
      status: PaymentStatus.PENDING,
      amountTotalCents: 12500,
      currency: "usd",
      requestedAt: "2026-09-04T12:00:00.000Z",
      checkoutExpiresAt: expiresAt.toISOString(),
      requestActive: expect.any(Boolean),
      checkoutUrl: "https://checkout.stripe.test/session",
    });
    expect(result).not.toHaveProperty("sessionId");
    expect(result).not.toHaveProperty("paymentIntentId");
  });

  it("replays the same request key through the provider without a duplicate audit", async () => {
    const requestKeyHash = createHash("sha256")
      .update(idempotencyKey)
      .digest("hex");
    const existing = paymentRecord({
      requestKeyHash,
      stripeCheckoutSessionId: "cs_test_private",
    });
    prisma.job.findFirst.mockResolvedValue(jobRecord({ payment: existing }));
    transaction.payment.updateMany.mockResolvedValue({ count: 0 });
    transaction.payment.findFirst.mockResolvedValue(existing);

    const result = await service.create(createInput());

    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(provider.createCheckout).toHaveBeenCalledTimes(1);
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
    expect(result.checkoutUrl).toBe("https://checkout.stripe.test/session");
  });

  it("fails before provider access for cross-tenant or missing jobs", async () => {
    prisma.job.findFirst.mockResolvedValue(null);

    await expect(service.create(createInput())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(provider.createCheckout).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it("fails closed when required pricing is missing", async () => {
    prisma.job.findFirst.mockResolvedValue(
      jobRecord({ pricingSnapshot: { currency: "usd" } }),
    );

    await expect(service.create(createInput())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it("rejects a second idempotency key while a request is pending", async () => {
    prisma.job.findFirst.mockResolvedValue(
      jobRecord({
        payment: paymentRecord({
          requestKeyHash: "different-request-key-hash",
          stripeCheckoutSessionId: "cs_existing",
        }),
      }),
    );

    await expect(service.create(createInput())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it("allows a new request key after the prior checkout expires", async () => {
    prisma.job.findFirst.mockResolvedValue(
      jobRecord({
        payment: paymentRecord({
          requestKeyHash: "expired-request-key-hash",
          checkoutExpiresAt: new Date(Date.now() - 60_000),
        }),
      }),
    );

    const result = await service.create(createInput());

    expect(prisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId,
          id: "payment-1",
          OR: expect.any(Array),
        }),
        data: expect.objectContaining({
          status: PaymentStatus.PENDING,
          checkoutExpiresAt: null,
          requestKeyHash: createHash("sha256")
            .update(idempotencyKey)
            .digest("hex"),
        }),
      }),
    );
    expect(provider.createCheckout).toHaveBeenCalledTimes(1);
    expect(result.checkoutUrl).toBe("https://checkout.stripe.test/session");
  });

  it("requires a new idempotency key after a checkout expires", async () => {
    const requestKeyHash = createHash("sha256")
      .update(idempotencyKey)
      .digest("hex");
    prisma.job.findFirst.mockResolvedValue(
      jobRecord({
        payment: paymentRecord({
          requestKeyHash,
          checkoutExpiresAt: new Date(Date.now() - 60_000),
        }),
      }),
    );

    await expect(service.create(createInput())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it("marks and audits a reserved request when checkout creation fails", async () => {
    prisma.job.findFirst.mockResolvedValue(jobRecord());
    provider.createCheckout.mockRejectedValue(
      new ServiceUnavailableException("provider unavailable"),
    );

    await expect(service.create(createInput())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(transaction.payment.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId,
        requestKeyHash: createHash("sha256")
          .update(idempotencyKey)
          .digest("hex"),
        stripeCheckoutSessionId: null,
      }),
      data: { status: PaymentStatus.FAILED },
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "payment.request_failed",
        metadata: expect.objectContaining({
          reasonCode: "CHECKOUT_PROVIDER_UNAVAILABLE",
        }),
      }),
    });
  });

  it("returns privacy-safe tracking without provider identifiers", async () => {
    prisma.job.findFirst.mockResolvedValue({ payment: paymentRecord() });

    const result = await service.get(tenantId, jobId);

    expect(result).toEqual({
      paymentRequestId: "payment-1",
      status: PaymentStatus.PENDING,
      amountTotalCents: 12500,
      currency: "usd",
      requestedAt: updatedAt.toISOString(),
      checkoutExpiresAt: expiresAt.toISOString(),
      requestActive: expect.any(Boolean),
    });
    expect(JSON.stringify(result)).not.toContain("stripe");
  });

  it("returns bounded tenant-scoped webhook visibility without provider identifiers", async () => {
    prisma.job.findFirst.mockResolvedValue({ payment: { id: "payment-1" } });
    prisma.stripeEvent.findMany.mockResolvedValue([
      {
        id: "70000000-0000-4000-8000-000000000007",
        type: "checkout.session.completed",
        processingStatus: "PROCESSED",
        receivedAt: updatedAt,
        processedAt: updatedAt,
      },
    ]);

    const result = await service.events(tenantId, jobId);

    expect(prisma.stripeEvent.findMany).toHaveBeenCalledWith({
      where: {
        tenantId,
        payload: { path: ["paymentId"], equals: "payment-1" },
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
    expect(result).toEqual([
      {
        id: "70000000-0000-4000-8000-000000000007",
        type: "checkout.session.completed",
        status: "PROCESSED",
        receivedAt: updatedAt.toISOString(),
        processedAt: updatedAt.toISOString(),
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("evt_");
    expect(JSON.stringify(result)).not.toContain("acct_");
  });

  it("returns no webhook events before a payment is requested", async () => {
    prisma.job.findFirst.mockResolvedValue({ payment: null });

    await expect(service.events(tenantId, jobId)).resolves.toEqual([]);
    expect(prisma.stripeEvent.findMany).not.toHaveBeenCalled();
  });

  it.each(["APPROVE", "REVOKE"] as const)(
    "holds payment exception %s before entitlement, write or provider access",
    async (action) => {
      transaction.job.findFirst.mockResolvedValue(
        jobRecord({ calendarOperations: [{ id: "private-operation" }] }),
      );
      await expect(
        service.governException({
          tenantId,
          jobId,
          actorId,
          traceId,
          action,
          reason: "Synthetic review",
          expectedJobUpdatedAt: updatedAt.toISOString(),
        }),
      ).rejects.toThrow("Calendar synchronization is unfinished");
      expect(transaction.tenantSubscription.findFirst).not.toHaveBeenCalled();
      expect(transaction.job.updateMany).not.toHaveBeenCalled();
      expect(transaction.auditLog.create).not.toHaveBeenCalled();
      expect(transaction.payment.updateMany).not.toHaveBeenCalled();
      expect(provider.createCheckout).not.toHaveBeenCalled();
    },
  );

  it("fails closed if the unfinished-operation selection is missing", async () => {
    transaction.job.findFirst.mockResolvedValue(
      jobRecord({ calendarOperations: undefined }),
    );
    await expect(
      service.governException({
        tenantId,
        jobId,
        actorId,
        traceId,
        action: "REVOKE",
        reason: "Synthetic review",
        expectedJobUpdatedAt: updatedAt.toISOString(),
      }),
    ).rejects.toThrow("Calendar synchronization is unfinished");
    expect(transaction.job.updateMany).not.toHaveBeenCalled();
  });

  it("preserves unrelated urgency policy and advances the version before exception audit", async () => {
    jest.useFakeTimers().setSystemTime(updatedAt);
    try {
      transaction.job.findFirst.mockResolvedValue(
        jobRecord({
          policySnapshot: {
            depositRequired: true,
            urgencyDecision: { level: "HIGH" },
            paymentGateException: { active: true },
          },
        }),
      );
      await service.governException({
        tenantId,
        jobId,
        actorId,
        traceId,
        action: "REVOKE",
        reason: "Synthetic review",
        expectedJobUpdatedAt: updatedAt.toISOString(),
      });
      expect(transaction.job.updateMany).toHaveBeenCalledWith({
        where: {
          id: jobId,
          tenantId,
          deletedAt: null,
          status: JobStatus.CREATED,
          updatedAt,
          calendarOperations: { none: { finishedAt: null } },
        },
        data: expect.objectContaining({
          updatedAt: new Date(updatedAt.getTime() + 1),
          policySnapshot: expect.objectContaining({
            depositRequired: true,
            urgencyDecision: { level: "HIGH" },
          }),
        }),
      });
      expect(transaction.payment.updateMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("rejects a lost exception claim without audit or payment mutation", async () => {
    transaction.job.findFirst.mockResolvedValue(
      jobRecord({
        policySnapshot: {
          depositRequired: true,
          paymentGateException: { active: true },
        },
      }),
    );
    transaction.job.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.governException({
        tenantId,
        jobId,
        actorId,
        traceId,
        action: "REVOKE",
        reason: "Synthetic review",
        expectedJobUpdatedAt: updatedAt.toISOString(),
      }),
    ).rejects.toThrow("Job changed while the payment exception");
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
    expect(transaction.payment.updateMany).not.toHaveBeenCalled();
  });

  it("approves a governed Growth payment exception without falsifying payment status", async () => {
    transaction.job.findFirst.mockResolvedValue(
      jobRecord({
        policySnapshot: {
          depositRequired: true,
          paymentGateMode: "manual_override",
        },
        payment: { status: PaymentStatus.PENDING },
      }),
    );

    const result = await service.governException({
      tenantId,
      jobId,
      actorId,
      traceId,
      action: "APPROVE",
      reason: "Owner approved payment when service is complete.",
      expectedJobUpdatedAt: updatedAt.toISOString(),
    });

    expect(transaction.tenantSubscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId }) }),
    );
    expect(transaction.job.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId,
        id: jobId,
        updatedAt,
      }),
      data: {
        updatedAt: expect.any(Date),
        policySnapshot: expect.objectContaining({
          depositRequired: true,
          paymentGateMode: "manual_override",
          paymentGateException: expect.objectContaining({
            active: true,
            approvedBy: actorId,
          }),
        }),
      },
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "payment.gate_exception_approved",
        actorUserId: actorId,
        metadata: expect.objectContaining({
          previousPaymentStatus: PaymentStatus.PENDING,
        }),
      }),
      select: { id: true },
    });
    expect(result.exception.active).toBe(true);
  });

  it("rejects exception approval for Starter without mutating the job", async () => {
    transaction.job.findFirst.mockResolvedValue(
      jobRecord({
        policySnapshot: {
          depositRequired: true,
          paymentGateMode: "manual_override",
        },
        payment: { status: PaymentStatus.PENDING },
      }),
    );
    transaction.tenantSubscription.findFirst.mockResolvedValue({
      planId: "starter",
    });

    await expect(
      service.governException({
        tenantId,
        jobId,
        actorId,
        traceId,
        action: "APPROVE",
        reason: "Attempted exception without advanced entitlement.",
        expectedJobUpdatedAt: updatedAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(transaction.job.updateMany).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it("revokes an active exception even when advanced entitlement is no longer active", async () => {
    transaction.job.findFirst.mockResolvedValue(
      jobRecord({
        policySnapshot: {
          depositRequired: true,
          paymentGateMode: "manual_override",
          paymentGateException: { active: true },
        },
        payment: { status: PaymentStatus.PENDING },
      }),
    );

    const result = await service.governException({
      tenantId,
      jobId,
      actorId,
      traceId,
      action: "REVOKE",
      reason: "Customer payment is required before dispatch after review.",
      expectedJobUpdatedAt: updatedAt.toISOString(),
    });

    expect(transaction.tenantSubscription.findFirst).not.toHaveBeenCalled();
    expect(transaction.job.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          updatedAt: expect.any(Date),
          policySnapshot: expect.objectContaining({
            paymentGateException: expect.objectContaining({ active: false }),
          }),
        },
      }),
    );
    expect(result.exception.active).toBe(false);
  });

  it("fails closed when the job changes before exception approval", async () => {
    transaction.job.findFirst.mockResolvedValue(
      jobRecord({
        updatedAt: new Date("2026-09-04T12:01:00.000Z"),
        policySnapshot: {
          depositRequired: true,
          paymentGateMode: "manual_override",
        },
        payment: { status: PaymentStatus.PENDING },
      }),
    );

    await expect(
      service.governException({
        tenantId,
        jobId,
        actorId,
        traceId,
        action: "APPROVE",
        reason: "Stale approval must not unlock this payment gate.",
        expectedJobUpdatedAt: updatedAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.tenantSubscription.findFirst).not.toHaveBeenCalled();
    expect(transaction.job.updateMany).not.toHaveBeenCalled();
  });

  it("recovers only the existing active connected-account Checkout", async () => {
    prisma.job.findFirst.mockResolvedValue({
      id: jobId,
      tenant: {
        stripeConnectAccountId: "acct_connected",
        chargesEnabled: true,
      },
      payment: paymentRecord(),
    });

    const result = await service.recover(tenantId, jobId);

    expect(provider.recoverCheckout).toHaveBeenCalledWith({
      connectedAccountId: "acct_connected",
      sessionId: "cs_test_private",
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId,
        action: "payment.checkout_recovered",
        actorType: "CUSTOMER",
        entityType: "Payment",
        entityId: "payment-1",
        metadata: {
          jobId,
          status: PaymentStatus.PENDING,
          checkoutExpiresAt: expiresAt.toISOString(),
        },
      }),
    });
    expect(result).toEqual({
      status: "payment_checkout",
      checkoutUrl: "https://checkout.stripe.com/c/pay/test",
      checkoutExpiresAt: expiresAt.toISOString(),
    });
  });

  it("fails before Stripe access when customer recovery is expired", async () => {
    prisma.job.findFirst.mockResolvedValue({
      id: jobId,
      tenant: {
        stripeConnectAccountId: "acct_connected",
        chargesEnabled: true,
      },
      payment: paymentRecord({
        checkoutExpiresAt: new Date(Date.now() - 60_000),
      }),
    });

    await expect(service.recover(tenantId, jobId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(provider.recoverCheckout).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects recovery when the destination no longer matches the tenant", async () => {
    prisma.job.findFirst.mockResolvedValue({
      id: jobId,
      tenant: {
        stripeConnectAccountId: "acct_other",
        chargesEnabled: true,
      },
      payment: paymentRecord(),
    });

    await expect(service.recover(tenantId, jobId)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(provider.recoverCheckout).not.toHaveBeenCalled();
  });
});

function createInput() {
  return {
    tenantId,
    jobId,
    actorId,
    traceId,
    idempotencyKey,
    expectedJobUpdatedAt: updatedAt.toISOString(),
  };
}

function jobRecord(overrides: Record<string, unknown> = {}) {
  return {
    calendarOperations: [],
    id: jobId,
    status: JobStatus.CREATED,
    updatedAt,
    policySnapshot: { depositRequired: true },
    pricingSnapshot: { depositAmountCents: 12500, currency: "USD" },
    tenant: {
      stripeConnectAccountId: "acct_connected",
      chargesEnabled: true,
    },
    payment: null,
    ...overrides,
  };
}

function paymentRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "payment-1",
    tenantId,
    jobId,
    jobTenantId: tenantId,
    status: PaymentStatus.PENDING,
    stripePaymentIntentId: "pi_test_private",
    stripeCheckoutSessionId: "cs_test_private",
    requestKeyHash: "request-key-hash",
    checkoutExpiresAt: expiresAt,
    requestedAt: updatedAt,
    stripeChargeId: null,
    destinationAccountId: "acct_connected",
    amountTotalCents: 12500,
    applicationFeeAmountCents: 0,
    currency: "usd",
    refundStatus: RefundStatus.NONE,
    refundAmountCents: null,
    stripeRefundId: null,
    refundReason: null,
    transferGroup: null,
    transferId: null,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  };
}
