import { createHash } from "crypto";
import {
  ConflictException,
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
