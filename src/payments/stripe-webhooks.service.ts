import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import {
  AuditActorType,
  PaymentStatus,
  Prisma,
  RefundStatus,
  StripeEventStatus,
} from "@prisma/client";
import appConfig from "../config/app.config";
import { PrismaService } from "../prisma/prisma.service";

const SIGNATURE_TOLERANCE_SECONDS = 300;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDLED_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "payment_intent.payment_failed",
  "charge.refunded",
]);

type StripeObject = Record<string, unknown>;
type StripeEvent = {
  id: string;
  type: string;
  account: string;
  livemode: boolean;
  created: number;
  data: { object: StripeObject };
};

type Transition = {
  status?: PaymentStatus;
  refundStatus?: RefundStatus;
  refundAmountCents?: number;
  stripePaymentIntentId?: string;
  stripeChargeId?: string;
};

@Injectable()
export class StripeWebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  async receive(rawBody: Buffer | undefined, signature: string | undefined) {
    const event = this.verify(rawBody, signature);
    if (!HANDLED_EVENTS.has(event.type)) {
      return { received: true, handled: false };
    }
    if (event.livemode !== this.config.stripeWebhookLivemode) {
      throw new UnprocessableEntityException(
        "Stripe webhook mode does not match the configured environment.",
      );
    }

    const tenant = await this.prisma.tenantOrganization.findFirst({
      where: { stripeConnectAccountId: event.account },
      select: { id: true },
    });
    if (!tenant) {
      throw new NotFoundException("Webhook account is not recognized.");
    }

    const payment = await this.findPayment(
      tenant.id,
      event.account,
      event.data.object,
    );
    if (!payment) {
      throw new NotFoundException("Webhook payment is not recognized.");
    }

    const transition = this.transition(event, payment);
    return this.prisma.$transaction(async (transaction) => {
      const inserted = await transaction.stripeEvent.createMany({
        data: {
          tenantId: tenant.id,
          stripeEventId: event.id,
          type: event.type,
          payload: this.auditPayload(event, payment.id),
          processingStatus: StripeEventStatus.PENDING,
        },
        skipDuplicates: true,
      });
      if (inserted.count === 0) {
        return { received: true, handled: true, duplicate: true };
      }

      const update = this.paymentUpdate(transition);
      if (Object.keys(update).length > 0) {
        await transaction.payment.update({
          where: { id_tenantId: { id: payment.id, tenantId: tenant.id } },
          data: update,
        });
        await transaction.auditLog.create({
          data: {
            tenantId: tenant.id,
            action: "payment.webhook_transitioned",
            actorType: AuditActorType.WEBHOOK,
            actorId: "stripe",
            entityType: "Payment",
            entityId: payment.id,
            traceId: randomUUID(),
            metadata: {
              jobId: payment.jobId,
              eventType: event.type,
              previousStatus: payment.status,
              status: transition.status ?? payment.status,
              refundStatus: transition.refundStatus ?? payment.refundStatus,
            },
          },
        });
      }
      await transaction.stripeEvent.update({
        where: {
          tenantId_stripeEventId: {
            tenantId: tenant.id,
            stripeEventId: event.id,
          },
        },
        data: {
          processingStatus: StripeEventStatus.PROCESSED,
          processedAt: new Date(),
          errorMessage: null,
        },
      });
      return { received: true, handled: true, duplicate: false };
    });
  }

  private verify(rawBody: Buffer | undefined, header: string | undefined) {
    const secret = this.config.stripeWebhookSecret;
    if (!secret) {
      throw new ServiceUnavailableException(
        "Stripe webhook processing is not configured.",
      );
    }
    if (!rawBody || !header) {
      throw new BadRequestException("Stripe webhook signature is missing.");
    }
    const parts = header.split(",").map((part) => part.trim().split("=", 2));
    const timestampText = parts.find(([key]) => key === "t")?.[1];
    const signatures = parts
      .filter(([key, value]) => key === "v1" && Boolean(value))
      .map(([, value]) => value);
    const timestamp = Number(timestampText);
    if (
      !Number.isSafeInteger(timestamp) ||
      Math.abs(Math.floor(Date.now() / 1000) - timestamp) >
        SIGNATURE_TOLERANCE_SECONDS ||
      signatures.length === 0
    ) {
      throw new UnauthorizedException("Stripe webhook signature is invalid.");
    }
    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest();
    const valid = signatures.some((candidate) => {
      if (!/^[0-9a-f]{64}$/i.test(candidate)) return false;
      const actual = Buffer.from(candidate, "hex");
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    });
    if (!valid) {
      throw new UnauthorizedException("Stripe webhook signature is invalid.");
    }

    let value: unknown;
    try {
      value = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new BadRequestException("Stripe webhook payload is invalid.");
    }
    if (!this.isEvent(value)) {
      throw new BadRequestException("Stripe webhook payload is invalid.");
    }
    return value;
  }

  private async findPayment(
    tenantId: string,
    connectedAccountId: string,
    object: StripeObject,
  ) {
    const metadata = this.record(object.metadata);
    const paymentRequestId =
      typeof metadata?.paymentRequestId === "string" &&
      UUID.test(metadata.paymentRequestId)
        ? metadata.paymentRequestId
        : null;
    const sessionId = this.prefixed(object.id, "cs_");
    const paymentIntentId =
      this.prefixed(object.payment_intent, "pi_") ??
      (this.prefixed(object.id, "pi_") ? String(object.id) : null);
    const chargeId = this.prefixed(object.id, "ch_");
    const options: Prisma.PaymentWhereInput[] = [];
    if (paymentRequestId) options.push({ id: paymentRequestId });
    if (sessionId) options.push({ stripeCheckoutSessionId: sessionId });
    if (paymentIntentId)
      options.push({ stripePaymentIntentId: paymentIntentId });
    if (chargeId) options.push({ stripeChargeId: chargeId });
    if (options.length === 0) return null;

    return this.prisma.payment.findFirst({
      where: {
        tenantId,
        destinationAccountId: connectedAccountId,
        OR: options,
      },
    });
  }

  private transition(
    event: StripeEvent,
    payment: {
      status: PaymentStatus;
      refundStatus: RefundStatus;
      amountTotalCents: number;
      currency: string;
    },
  ): Transition {
    const object = event.data.object;
    if (
      event.type === "checkout.session.completed" &&
      object.payment_status !== "paid" &&
      object.payment_status !== "no_payment_required"
    ) {
      return {};
    }
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      this.assertExpectedMoney(object, payment);
      if (payment.status === PaymentStatus.REFUNDED) return {};
      return {
        status: PaymentStatus.SUCCEEDED,
        stripePaymentIntentId:
          this.prefixed(object.payment_intent, "pi_") ?? undefined,
      };
    }
    if (
      (event.type === "checkout.session.async_payment_failed" ||
        event.type === "payment_intent.payment_failed") &&
      payment.status === PaymentStatus.PENDING
    ) {
      return { status: PaymentStatus.FAILED };
    }
    if (
      event.type === "checkout.session.expired" &&
      payment.status === PaymentStatus.PENDING
    ) {
      return { status: PaymentStatus.CANCELED };
    }
    if (event.type === "charge.refunded") {
      this.assertExpectedMoney(
        { amount_total: object.amount, currency: object.currency },
        payment,
      );
      const refunded = this.nonnegativeInteger(object.amount_refunded);
      const amount = this.nonnegativeInteger(object.amount);
      if (refunded === null || amount === null || refunded > amount) {
        throw new UnprocessableEntityException(
          "Stripe refund amount is invalid.",
        );
      }
      return {
        status: refunded === amount ? PaymentStatus.REFUNDED : payment.status,
        refundStatus:
          refunded === amount ? RefundStatus.FULL : RefundStatus.PARTIAL,
        refundAmountCents: refunded,
        stripeChargeId: this.prefixed(object.id, "ch_") ?? undefined,
      };
    }
    return {};
  }

  private assertExpectedMoney(
    object: StripeObject,
    payment: { amountTotalCents: number; currency: string },
  ) {
    if (
      object.amount_total !== payment.amountTotalCents ||
      object.currency !== payment.currency
    ) {
      throw new UnprocessableEntityException(
        "Stripe payment amount does not match the payment request.",
      );
    }
  }

  private paymentUpdate(transition: Transition): Prisma.PaymentUpdateInput {
    return {
      ...(transition.status ? { status: transition.status } : {}),
      ...(transition.refundStatus
        ? { refundStatus: transition.refundStatus }
        : {}),
      ...(transition.refundAmountCents !== undefined
        ? { refundAmountCents: transition.refundAmountCents }
        : {}),
      ...(transition.stripePaymentIntentId
        ? { stripePaymentIntentId: transition.stripePaymentIntentId }
        : {}),
      ...(transition.stripeChargeId
        ? { stripeChargeId: transition.stripeChargeId }
        : {}),
    };
  }

  private auditPayload(event: StripeEvent, paymentId: string) {
    return {
      type: event.type,
      paymentId,
      created: event.created,
    } satisfies Prisma.InputJsonObject;
  }

  private isEvent(value: unknown): value is StripeEvent {
    const event = this.record(value);
    const data = this.record(event?.data);
    return Boolean(
      event &&
        typeof event.id === "string" &&
        event.id.startsWith("evt_") &&
        typeof event.type === "string" &&
        typeof event.account === "string" &&
        event.account.startsWith("acct_") &&
        typeof event.livemode === "boolean" &&
        Number.isSafeInteger(event.created) &&
        data &&
        this.record(data.object),
    );
  }

  private record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private prefixed(value: unknown, prefix: string): string | null {
    return typeof value === "string" && value.startsWith(prefix) ? value : null;
  }

  private nonnegativeInteger(value: unknown): number | null {
    return Number.isSafeInteger(value) && Number(value) >= 0
      ? Number(value)
      : null;
  }
}
