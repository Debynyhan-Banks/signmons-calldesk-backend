import { Injectable } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { LoggingService } from "../logging/logging.service";
import { SmsDeliveryService } from "./sms-delivery.service";

@Injectable()
export class SmsDeliveryWorker {
  private running = false;

  constructor(
    private readonly delivery: SmsDeliveryService,
    private readonly logging: LoggingService,
  ) {}

  @Interval(60_000)
  async processDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.delivery.processDue();
    } catch (error) {
      this.logging.error(
        "SMS delivery worker failed.",
        error instanceof Error ? error : undefined,
        SmsDeliveryWorker.name,
      );
    } finally {
      this.running = false;
    }
  }
}
