import { Injectable } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { LoggingService } from "../logging/logging.service";
import { SmsDeliveryService } from "./sms-delivery.service";
import { SmsEnqueueIntentService } from "./sms-enqueue-intent.service";

@Injectable()
export class SmsDeliveryWorker {
  private running = false;

  constructor(
    private readonly delivery: SmsDeliveryService,
    private readonly logging: LoggingService,
    private readonly intents: SmsEnqueueIntentService,
  ) {}

  @Interval(60_000)
  async processDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      try {
        await this.intents.processDue();
      } catch {
        // Existing queued messages must not be held behind an outbox scan failure.
        try {
          this.logging.warn(
            "SMS enqueue intent recovery failed.",
            SmsDeliveryWorker.name,
          );
        } catch {
          // Logging is not a prerequisite for draining the existing delivery queue.
        }
      }
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
