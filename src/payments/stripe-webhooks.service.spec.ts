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
    stripeEvent: {
      createMany: jest.fn(),
      update: jest.fn(),
    },
    payment: { update: jest.fn() },
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
  } as ConfigType<typeof appConfig>;
  const service = new StripeWebhooksService(
    prisma as unknown as PrismaService,
    config,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.tenantOrganization.findFirst.mockResolvedValue({ id: tenantId });
    prisma.payment.findFirst.mockResolvedValue(payment());
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

  it("records a full refund without allowing later success to downgrade it", async () => {
    prisma.payment.findFirst.mockResolvedValue(
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
    ...overrides,
  };
}

function event(type: string, object: Record<string, unknown>) {
  return {
    id: "evt_test_event",
    type,
    account: accountId,
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
