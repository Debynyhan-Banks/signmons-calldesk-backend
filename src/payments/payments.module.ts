import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { TenantGuard } from "../common/guards/tenant.guard";
import { PaymentOperationsAccessGuard } from "./payment-operations-access.guard";
import { PaymentRequestsController } from "./payment-requests.controller";
import { PaymentRequestsService } from "./payment-requests.service";
import { PAYMENT_CHECKOUT_PROVIDER } from "./payments.constants";
import { StripeCheckoutProvider } from "./stripe-checkout.provider";
import { StripeWebhooksController } from "./stripe-webhooks.controller";
import { StripeWebhooksService } from "./stripe-webhooks.service";

@Module({
  imports: [AuthModule],
  controllers: [PaymentRequestsController, StripeWebhooksController],
  providers: [
    PaymentRequestsService,
    PaymentOperationsAccessGuard,
    TenantGuard,
    StripeWebhooksService,
    {
      provide: PAYMENT_CHECKOUT_PROVIDER,
      useClass: StripeCheckoutProvider,
    },
  ],
  exports: [PaymentRequestsService],
})
export class PaymentsModule {}
