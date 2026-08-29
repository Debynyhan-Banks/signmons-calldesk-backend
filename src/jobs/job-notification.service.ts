import { Inject, Injectable } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import appConfig from "../config/app.config";
import { LoggingService } from "../logging/logging.service";
import type { JobRecord } from "./interfaces/job-repository.interface";

type NotificationChannel = "email" | "sms";

@Injectable()
export class JobNotificationService {
  constructor(
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
    private readonly loggingService: LoggingService,
  ) {}

  async notifyJobCreated(job: JobRecord): Promise<void> {
    const deliveries: Array<{
      channel: NotificationChannel;
      send: () => Promise<void>;
    }> = [];

    if (this.config.jobNotificationEmails.length > 0) {
      if (this.config.resendApiKey && this.config.resendFromEmail) {
        deliveries.push({ channel: "email", send: () => this.sendEmail(job) });
      } else {
        this.logConfigurationWarning(job.id, "email");
      }
    }

    if (this.config.jobNotificationSmsNumbers.length > 0) {
      if (
        this.config.twilioAccountSid &&
        this.config.twilioAuthToken &&
        this.config.twilioPhoneNumber
      ) {
        deliveries.push({ channel: "sms", send: () => this.sendSms(job) });
      } else {
        this.logConfigurationWarning(job.id, "sms");
      }
    }

    if (deliveries.length === 0) {
      this.loggingService.warn(
        {
          event: "job_notification_not_configured",
          jobId: job.id,
        },
        JobNotificationService.name,
      );
      return;
    }

    const results = await Promise.allSettled(
      deliveries.map((delivery) => delivery.send()),
    );

    results.forEach((result, index) => {
      const channel = deliveries[index].channel;
      if (result.status === "fulfilled") {
        this.loggingService.log(
          { event: "job_notification_sent", channel, jobId: job.id },
          JobNotificationService.name,
        );
        return;
      }

      this.loggingService.error(
        `New-job ${channel} notification failed for job ${job.id}.`,
        result.reason instanceof Error ? result.reason : undefined,
        JobNotificationService.name,
      );
    });
  }

  private async sendEmail(job: JobRecord): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.resendApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.config.resendFromEmail,
        to: this.config.jobNotificationEmails,
        subject: `${job.urgency === "EMERGENCY" ? "URGENT: " : ""}New Signmons request — ${job.issueCategory}`,
        text: this.buildPlainText(job),
        html: this.buildHtml(job),
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      throw new Error(`Resend returned HTTP ${response.status}.`);
    }
  }

  private async sendSms(job: JobRecord): Promise<void> {
    const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.twilioAccountSid)}/Messages.json`;
    const authorization = Buffer.from(
      `${this.config.twilioAccountSid}:${this.config.twilioAuthToken}`,
    ).toString("base64");
    const body = this.buildSms(job);

    const results = await Promise.all(
      this.config.jobNotificationSmsNumbers.map(async (recipient) => {
        const form = new URLSearchParams({
          From: this.config.twilioPhoneNumber,
          To: recipient,
          Body: body,
        });
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Basic ${authorization}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) {
          throw new Error(`Twilio returned HTTP ${response.status}.`);
        }
      }),
    );

    void results;
  }

  private buildPlainText(job: JobRecord): string {
    return [
      "New service request created by Signmons",
      `Reference: ${this.reference(job.id)}`,
      `Customer: ${job.customerName}`,
      `Phone: ${job.phone}`,
      `Service: ${job.issueCategory}`,
      `Urgency: ${job.urgency}`,
      `Preferred time: ${job.preferredTimeText ?? job.preferredTime ?? "Not provided"}`,
      `Address: ${job.address ?? "Not provided"}`,
      `Details: ${job.description ?? "Not provided"}`,
      "The requested time is a preference and is not a confirmed appointment.",
    ].join("\n");
  }

  private buildHtml(job: JobRecord): string {
    const rows = [
      ["Reference", this.reference(job.id)],
      ["Customer", job.customerName],
      ["Phone", job.phone],
      ["Service", job.issueCategory],
      ["Urgency", job.urgency],
      [
        "Preferred time",
        job.preferredTimeText ?? job.preferredTime ?? "Not provided",
      ],
      ["Address", job.address ?? "Not provided"],
      ["Details", job.description ?? "Not provided"],
    ]
      .map(
        ([label, value]) =>
          `<tr><th style="padding:8px 12px;text-align:left;background:#f1f5f8;color:#44536a">${escapeHtml(label)}</th><td style="padding:8px 12px;color:#0b2646">${escapeHtml(value)}</td></tr>`,
      )
      .join("");

    return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#0b2646"><div style="max-width:640px;border:1px solid #d9e1ec"><div style="padding:20px 24px;background:#0b2646;color:white;border-bottom:5px solid #f47a38"><strong>New Signmons service request</strong></div><div style="padding:24px"><table style="width:100%;border-collapse:collapse">${rows}</table><p style="margin:20px 0 0;color:#667085">The requested time is a preference and is not a confirmed appointment.</p><p><a href="tel:${escapeHtml(job.phone)}" style="display:inline-block;padding:12px 16px;background:#f47a38;color:#0b2646;text-decoration:none;font-weight:bold">Call customer</a></p></div></div></body></html>`;
  }

  private buildSms(job: JobRecord): string {
    const time = job.preferredTimeText ?? job.preferredTime ?? "not provided";
    return `New Signmons request ${this.reference(job.id)}: ${job.customerName}, ${job.phone}, ${job.issueCategory}, ${job.urgency}, preferred ${time}. Not yet confirmed.`;
  }

  private reference(jobId: string): string {
    return jobId.replace(/-/g, "").slice(0, 8).toUpperCase();
  }

  private logConfigurationWarning(
    jobId: string,
    channel: NotificationChannel,
  ): void {
    this.loggingService.warn(
      { event: "job_notification_misconfigured", channel, jobId },
      JobNotificationService.name,
    );
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}
