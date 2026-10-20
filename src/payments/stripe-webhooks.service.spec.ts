import { createHmac } from "crypto";
import {
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PaymentStatus, RefundStatus, StripeEventStatus } from "@prisma/client";
import type { ConfigType } from "@nestjs/config";
import appConfig from "../config/app.config";
import type { PrismaService } from "../prisma/prisma.service";
import { StripeWebhooksService } from "./stripe-webhooks.service";

const webhookSecret = "whsec_test_webhook_secret";
const tenantId = "10000000-0000-4000-8000-000000000001";
const paymentId = "20000000-0000-4000-8000-000000000002";
const jobId = "30000000-0000-4000-8000-000000000003";
const accountId = "acct_connected";
const timestamp = Math.floor(Date.now() / 1000);

describe("StripeWebhooksService", () => {
  const transaction = {
    $queryRaw: jest.fn(),
    tenantOrganization: { findFirst: jest.fn() },
    stripeEvent: {
      createMany: jest.fn(),
      update: jest.fn(),
    },
    payment: { findFirst: jest.fn(), update: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    tenantOrganization: { findFirst: jest.fn() },
    payment: { findFirst: jest.fn() },
    $transaction: jest.fn((callback: (client: typeof transaction) => unknown) =>
      Promise.resolve(callback(transaction)),
    ),
  };
  const config = {
    stripeWebhookSecret: webhookSecret,
    stripeWebhookLivemode: false,
  } as ConfigType<typeof appConfig>;
  const service = new StripeWebhooksService(
    prisma as unknown as PrismaService,
    config,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.tenantOrganization.findFirst.mockResolvedValue({ id: tenantId });
    prisma.payment.findFirst.mockResolvedValue(payment());
    transaction.$queryRaw.mockResolvedValue([{ id: paymentId }]);
    transaction.tenantOrganization.findFirst.mockResolvedValue({
      id: tenantId,
    });
    transaction.payment.findFirst.mockResolvedValue(payment());
    transaction.stripeEvent.createMany.mockResolvedValue({ count: 1 });
    transaction.stripeEvent.update.mockResolvedValue({ id: "stored-event" });
    transaction.payment.update.mockResolvedValue(payment());
    transaction.auditLog.create.mockResolvedValue({ id: "audit" });
  });

  it("verifies and applies a paid Checkout event exactly once", async () => {
    const request = signedRequest(
      event("checkout.session.completed", {
        id: "cs_test_success",
        payment_status: "paid",
        payment_intent: "pi_test_success",
        amount_total: 10000,
        currency: "usd",
        metadata: { paymentRequestId: paymentId },
      }),
    );

    await expect(
      service.receive(request.body, request.header),
    ).resolves.toEqual({ received: true, handled: true, duplicate: false });
    expect(prisma.tenantOrganization.findFirst).toHaveBeenCalledWith({
      where: { stripeConnectAccountId: accountId },
      select: { id: true },
    });
    expect(prisma.payment.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId,
        destinationAccountId: accountId,
      }),
    });
    const [lock] = transaction.$queryRaw.mock.calls[0] as [
      { strings: string[]; values: unknown[] },
    ];
    expect(lock.strings.join("")).toMatch(/SELECT[\s\S]*"Payment"/);
    expect(lock.strings.join("")).toMatch(/FOR UPDATE/);
    expect(lock.values).toHaveLength(2);
    expect(lock.values).toEqual(expect.arrayContaining([paymentId, tenantId]));
    expect(transaction.tenantOrganization.findFirst).toHaveBeenCalledWith({
      where: { id: tenantId, stripeConnectAccountId: accountId },
      select: { id: true },
    });
    expect(transaction.payment.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId,
        destinationAccountId: accountId,
        stripeCheckoutSessionId: "cs_test_success",
      }),
    });
    expect(transaction.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.payment.findFirst.mock.invocationCallOrder[0],
    );
    expect(
      transaction.payment.findFirst.mock.invocationCallOrder[0],
    ).toBeLessThan(transaction.payment.update.mock.invocationCallOrder[0]);
    expect(transaction.payment.update).toHaveBeenCalledWith({
      where: { id_tenantId: { id: paymentId, tenantId } },
      data: {
        status: PaymentStatus.SUCCEEDED,
        stripePaymentIntentId: "pi_test_success",
      },
    });
    expect(transaction.stripeEvent.update).toHaveBeenCalledWith({
      where: {
        tenantId_stripeEventId: {
          tenantId,
          stripeEventId: "evt_test_event",
        },
      },
      data: expect.objectContaining({
        processingStatus: StripeEventStatus.PROCESSED,
      }),
    });
    expect(
      JSON.stringify(transaction.stripeEvent.createMany.mock.calls),
    ).not.toContain("customer_email");
  });

  it("rejects invalid signatures before database access", async () => {
    const request = signedRequest(event("checkout.session.completed", {}));

    await expect(
      service.receive(request.body, `t=${timestamp},v1=${"0".repeat(64)}`),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.tenantOrganization.findFirst).not.toHaveBeenCalled();
  });

  it("rejects stale signed requests", async () => {
    const request = signedRequest(
      event("checkout.session.completed", {}),
      timestamp - 301,
    );

    await expect(
      service.receive(request.body, request.header),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("acknowledges duplicate delivery without repeating side effects", async () => {
    transaction.stripeEvent.createMany.mockResolvedValue({ count: 0 });
    const request = signedRequest(
      event("checkout.session.completed", {
        id: "cs_test_success",
        payment_status: "paid",
        payment_intent: "pi_test_success",
        amount_total: 10000,
        currency: "usd",
        metadata: { paymentRequestId: paymentId },
      }),
    );

    await expect(
      service.receive(request.body, request.header),
    ).resolves.toEqual({ received: true, handled: true, duplicate: true });
    expect(transaction.payment.update).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it("fails closed when the connected account is not a tenant", async () => {
    prisma.tenantOrganization.findFirst.mockResolvedValue(null);
    const request = signedRequest(event("checkout.session.expired", {}));

    await expect(
      service.receive(request.body, request.header),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.payment.findFirst).not.toHaveBeenCalled();
  });

  it("rejects a paid event whose amount differs from trusted state", async () => {
    const request = signedRequest(
      event("checkout.session.completed", {
        id: "cs_test_success",
        payment_status: "paid",
        amount_total: 9999,
        currency: "usd",
        metadata: { paymentRequestId: paymentId },
      }),
    );

    await expect(
      service.receive(request.body, request.header),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects copied payment metadata when the Checkout Session is foreign", async () => {
    const request = signedRequest(
      event("checkout.session.completed", {
        id: "cs_test_foreign",
        payment_status: "paid",
        payment_intent: "pi_test_success",
        amount_total: 10000,
        currency: "usd",
        metadata: { paymentRequestId: paymentId, jobId, tenantId },
      }),
    );
    prisma.payment.findFirst.mockResolvedValue(null);

    await expect(
      service.receive(request.body, request.header),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.payment.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId,
        destinationAccountId: accountId,
        stripeCheckoutSessionId: "cs_test_foreign",
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an exact Checkout resource with mismatched stored metadata", async () => {
    const request = signedRequest(
      event("checkout.session.completed", {
        id: "cs_test_success",
        payment_status: "paid",
        payment_intent: "pi_test_success",
        amount_total: 10000,
        currency: "usd",
        metadata: {
          paymentRequestId: paymentId,
          jobId: "40000000-0000-4000-8000-000000000004",
          tenantId,
        },
      }),
    );

    await expect(
      service.receive(request.body, request.header),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("requires the stored PaymentIntent for a failure event", async () => {
    const request = signedRequest(
      event("payment_intent.payment_failed", {
        id: "pi_test_foreign",
        metadata: { paymentRequestId: paymentId },
      }),
    );
    prisma.payment.findFirst.mockResolvedValue(null);

    await expect(
      service.receive(request.body, request.header),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.payment.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId,
        destinationAccountId: accountId,
        stripePaymentIntentId: "pi_test_foreign",
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a refund from a different Charge after the Charge is bound", async () => {
    prisma.payment.findFirst.mockResolvedValue(
      payment({
        status: PaymentStatus.SUCCEEDED,
        stripeChargeId: "ch_test_bound",
      }),
    );
    const request = signedRequest(
      event("charge.refunded", {
        id: "ch_test_foreign",
        payment_intent: "pi_test_success",
        amount: 10000,
        amount_refunded: 10000,
        currency: "usd",
      }),
    );

    await expect(
      service.receive(request.body, request.header),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a signed event from the wrong Stripe mode before database access", async () => {
    const request = signedRequest(
      event(
        "checkout.session.completed",
        {
          id: "cs_live_unexpected",
          payment_status: "paid",
          amount_total: 10000,
          currency: "usd",
          metadata: { paymentRequestId: paymentId },
        },
        true,
      ),
    );

    await expect(
      service.receive(request.body, request.header),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.tenantOrganization.findFirst).not.toHaveBeenCalled();
    expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["checkout.session.async_payment_failed", PaymentStatus.FAILED],
    ["payment_intent.payment_failed", PaymentStatus.FAILED],
    ["checkout.session.expired", PaymentStatus.CANCELED],
  ])("maps %s to %s while payment is pending", async (type, status) => {
    const object = {
      id: type.startsWith("payment_intent")
        ? "pi_test_failure"
        : "cs_test_failure",
      payment_intent: "pi_test_failure",
      metadata: { paymentRequestId: paymentId },
    };
    const request = signedRequest(event(type, object));

    await service.receive(request.body, request.header);

    expect(transaction.payment.update).toHaveBeenCalledWith({
      where: { id_tenantId: { id: paymentId, tenantId } },
      data: { status },
    });
  });

  it.each([
    "checkout.session.async_payment_failed",
    "payment_intent.payment_failed",
    "checkout.session.expired",
  ])("does not let stale %s overwrite committed success", async (type) => {
    transaction.payment.findFirst.mockResolvedValue(
      payment({ status: PaymentStatus.SUCCEEDED }),
    );
    const request = signedRequest(
      event(type, {
        id: type.startsWith("payment_intent")
          ? "pi_test_success"
          : "cs_test_success",
        metadata: { paymentRequestId: paymentId, jobId, tenantId },
      }),
    );

    await expect(
      service.receive(request.body, request.header),
    ).resolves.toEqual({ received: true, handled: true, duplicate: false });

    expect(transaction.payment.findFirst).toHaveBeenCalled();
    expect(transaction.payment.update).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
    expect(transaction.stripeEvent.update).toHaveBeenCalledWith({
      where: {
        tenantId_stripeEventId: { tenantId, stripeEventId: "evt_test_event" },
      },
      data: expect.objectContaining({
        processingStatus: StripeEventStatus.PROCESSED,
      }),
    });
  });

  it("preserves a refund committed after the initial pending lookup", async () => {
    transaction.payment.findFirst.mockResolvedValue(
      payment({
        status: PaymentStatus.REFUNDED,
        refundStatus: RefundStatus.FULL,
      }),
    );
    const request = signedRequest(
      event("checkout.session.completed", {
        id: "cs_test_success",
        payment_status: "paid",
        amount_total: 10000,
        currency: "usd",
        metadata: { paymentRequestId: paymentId },
      }),
    );

    await service.receive(request.body, request.header);

    expect(transaction.payment.update).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
    expect(transaction.stripeEvent.update).toHaveBeenCalled();
  });

  it("uses the current state in the transition audit", async () => {
    transaction.payment.findFirst.mockResolvedValue(
      payment({ status: PaymentStatus.FAILED }),
    );
    const request = signedRequest(
      event("checkout.session.completed", {
        id: "cs_test_success",
        payment_status: "paid",
        amount_total: 10000,
        currency: "usd",
        metadata: { paymentRequestId: paymentId },
      }),
    );

    await service.receive(request.body, request.header);

    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: paymentId,
        metadata: expect.objectContaining({
          previousStatus: PaymentStatus.FAILED,
          status: PaymentStatus.SUCCEEDED,
        }),
      }),
    });
  });

  it.each([null, { id: "40000000-0000-4000-8000-000000000004" }])(
    "rejects a changed account mapping before writing an event (%p)",
    async (currentTenant) => {
      transaction.tenantOrganization.findFirst.mockResolvedValue(currentTenant);
      const request = signedRequest(
        event("checkout.session.expired", { id: "cs_test_success" }),
      );

      await expect(
        service.receive(request.body, request.header),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(transaction.stripeEvent.createMany).not.toHaveBeenCalled();
      expect(transaction.payment.update).not.toHaveBeenCalled();
      expect(transaction.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    { lockedRows: [] },
    { lockedRows: [{ id: "40000000-0000-4000-8000-000000000004" }] },
  ])(
    "rejects a missing or mismatched locked row before writing an event ($lockedRows)",
    async ({ lockedRows }) => {
      transaction.$queryRaw.mockResolvedValue(lockedRows);
      const request = signedRequest(
        event("checkout.session.expired", { id: "cs_test_success" }),
      );

      await expect(
        service.receive(request.body, request.header),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(transaction.payment.findFirst).not.toHaveBeenCalled();
      expect(transaction.stripeEvent.createMany).not.toHaveBeenCalled();
      expect(transaction.payment.update).not.toHaveBeenCalled();
    },
  );

  it.each([null, payment({ id: "40000000-0000-4000-8000-000000000004" })])(
    "rejects a resource no longer bound to the locked payment (%p)",
    async (currentPayment) => {
      transaction.payment.findFirst.mockResolvedValue(currentPayment);
      const request = signedRequest(
        event("checkout.session.expired", { id: "cs_test_success" }),
      );

      await expect(
        service.receive(request.body, request.header),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(transaction.stripeEvent.createMany).not.toHaveBeenCalled();
      expect(transaction.payment.update).not.toHaveBeenCalled();
      expect(transaction.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, { paymentRequestId: paymentId, jobId, tenantId }])(
    "refuses a changed job with or without event metadata (%p)",
    async (metadata) => {
      transaction.payment.findFirst.mockResolvedValue(
        payment({ jobId: "40000000-0000-4000-8000-000000000004" }),
      );
      const request = signedRequest(
        event("checkout.session.expired", {
          id: "cs_test_success",
          metadata,
        }),
      );

      await expect(
        service.receive(request.body, request.header),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(transaction.stripeEvent.createMany).not.toHaveBeenCalled();
      expect(transaction.payment.update).not.toHaveBeenCalled();
    },
  );

  it("revalidates current trusted money before writing an event", async () => {
    transaction.payment.findFirst.mockResolvedValue(
      payment({ amountTotalCents: 20000 }),
    );
    const request = signedRequest(
      event("checkout.session.completed", {
        id: "cs_test_success",
        payment_status: "paid",
        amount_total: 10000,
        currency: "usd",
        metadata: { paymentRequestId: paymentId },
      }),
    );

    await expect(
      service.receive(request.body, request.header),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(transaction.stripeEvent.createMany).not.toHaveBeenCalled();
    expect(transaction.payment.update).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it("records a full refund without allowing later success to downgrade it", async () => {
    prisma.payment.findFirst.mockResolvedValue(
      payment({ status: PaymentStatus.SUCCEEDED }),
    );
    transaction.payment.findFirst.mockResolvedValue(
      payment({ status: PaymentStatus.SUCCEEDED }),
    );
    const refund = signedRequest(
      event("charge.refunded", {
        id: "ch_test_refund",
        payment_intent: "pi_test_success",
        amount: 10000,
        amount_refunded: 10000,
        currency: "usd",
      }),
    );

    await service.receive(refund.body, refund.header);

    expect(transaction.payment.update).toHaveBeenCalledWith({
      where: { id_tenantId: { id: paymentId, tenantId } },
      data: {
        status: PaymentStatus.REFUNDED,
        refundStatus: RefundStatus.FULL,
        refundAmountCents: 10000,
        stripeChargeId: "ch_test_refund",
      },
    });

    jest.clearAllMocks();
    prisma.tenantOrganization.findFirst.mockResolvedValue({ id: tenantId });
    prisma.payment.findFirst.mockResolvedValue(
      payment({
        status: PaymentStatus.REFUNDED,
        refundStatus: RefundStatus.FULL,
      }),
    );
    transaction.payment.findFirst.mockResolvedValue(
      payment({
        status: PaymentStatus.REFUNDED,
        refundStatus: RefundStatus.FULL,
      }),
    );
    transaction.stripeEvent.createMany.mockResolvedValue({ count: 1 });
    const lateSuccess = signedRequest(
      event("checkout.session.completed", {
        id: "cs_test_success",
        payment_status: "paid",
        amount_total: 10000,
        currency: "usd",
        metadata: { paymentRequestId: paymentId },
      }),
    );

    await service.receive(lateSuccess.body, lateSuccess.header);

    expect(transaction.payment.update).not.toHaveBeenCalled();
    expect(transaction.stripeEvent.update).toHaveBeenCalled();
  });
});

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: paymentId,
    tenantId,
    jobId,
    status: PaymentStatus.PENDING,
    refundStatus: RefundStatus.NONE,
    amountTotalCents: 10000,
    currency: "usd",
    destinationAccountId: accountId,
    stripeCheckoutSessionId: "cs_test_success",
    stripePaymentIntentId: "pi_test_success",
    stripeChargeId: null,
    ...overrides,
  };
}

function event(
  type: string,
  object: Record<string, unknown>,
  livemode = false,
) {
  return {
    id: "evt_test_event",
    type,
    account: accountId,
    livemode,
    created: timestamp,
    data: { object },
  };
}

function signedRequest(value: unknown, signedAt = timestamp) {
  const body = Buffer.from(JSON.stringify(value));
  const signature = createHmac("sha256", webhookSecret)
    .update(`${signedAt}.`)
    .update(body)
    .digest("hex");
  return { body, header: `t=${signedAt},v1=${signature}` };
}
