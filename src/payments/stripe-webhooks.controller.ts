import { Controller, Headers, HttpCode, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { SkipThrottle } from "@nestjs/throttler";
import { StripeWebhooksService } from "./stripe-webhooks.service";

@Controller("webhooks/stripe")
@SkipThrottle()
export class StripeWebhooksController {
  constructor(private readonly webhooks: StripeWebhooksService) {}

  @Post()
  @HttpCode(200)
  receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers("stripe-signature") signature: string | undefined,
  ) {
    return this.webhooks.receive(request.rawBody, signature);
  }
}
