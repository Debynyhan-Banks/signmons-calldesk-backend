import { Inject, Injectable } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import appConfig from "../config/app.config";
import { LoggingService } from "../logging/logging.service";
import type { JobRecord } from "./interfaces/job-repository.interface";

type NotificationChannel = "email" | "sms";
type JobNotificationKind =
  | "request_created"
  | "appointment_confirmed"
  | "appointment_rescheduled"
  | "appointment_cancelled"
  | "urgency_escalated";

export interface NotificationDeliveryOutcome {
  channel: NotificationChannel | "internal";
  recipientGroup: "operations";
  outcome: "delivered" | "failed" | "misconfigured" | "not_configured";
}

@Injectable()
export class JobNotificationService {
  constructor(
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
    private readonly loggingService: LoggingService,
  ) {}

  enqueueJobCreated(job: JobRecord): void {
    void this.notifyJobCreated(job).catch((error: unknown) => {
      this.loggingService.error(
        `Unexpected new-job notification failure for job ${job.id}.`,
        error instanceof Error ? error : undefined,
        JobNotificationService.name,
      );
    });
  }

  enqueueAppointmentConfirmed(job: JobRecord): void {
    void this.notifyAppointmentConfirmed(job).catch((error: unknown) => {
      this.loggingService.error(
        `Unexpected appointment notification failure for job ${job.id}.`,
        error instanceof Error ? error : undefined,
        JobNotificationService.name,
      );
    });
  }

  enqueueAppointmentRescheduled(job: JobRecord): void {
    void this.notifyAppointmentRescheduled(job).catch((error: unknown) => {
      this.loggingService.error(
        `Unexpected appointment reschedule notification failure for job ${job.id}.`,
        error instanceof Error ? error : undefined,
        JobNotificationService.name,
      );
    });
  }

  enqueueAppointmentCancelled(job: JobRecord): void {
    void this.notifyAppointmentCancelled(job).catch((error: unknown) => {
      this.loggingService.error(
        `Unexpected appointment cancellation notification failure for job ${job.id}.`,
        error instanceof Error ? error : undefined,
        JobNotificationService.name,
      );
    });
  }

  enqueueOrphanedIntake(sessionId: string, reason: string): void {
    void this.notifyOrphanedIntake(sessionId, reason).catch(
      (error: unknown) => {
        this.loggingService.error(
          `Unexpected orphaned-intake notification failure for session ${sessionId}.`,
          error instanceof Error ? error : undefined,
          JobNotificationService.name,
        );
      },
    );
  }

  async notifyAppointmentConfirmed(job: JobRecord): Promise<void> {
    await this.deliver(job, "appointment_confirmed");
  }

  async notifyAppointmentRescheduled(job: JobRecord): Promise<void> {
    await this.deliver(job, "appointment_rescheduled");
  }

  async notifyAppointmentCancelled(job: JobRecord): Promise<void> {
    await this.deliver(job, "appointment_cancelled");
  }

  async notifyJobCreated(job: JobRecord): Promise<void> {
    await this.deliver(job, "request_created");
  }

  async notifyUrgencyEscalation(
    job: JobRecord,
  ): Promise<NotificationDeliveryOutcome[]> {
    return this.deliver(job, "urgency_escalated");
  }

  async notifyOrphanedIntake(sessionId: string, reason: string): Promise<void> {
    if (
      this.config.jobNotificationEmails.length === 0 ||
      !this.config.resendApiKey ||
      !this.config.resendFromEmail
    ) {
      this.loggingService.warn(
        { event: "orphaned_intake_notification_not_configured", sessionId },
        JobNotificationService.name,
      );
      return;
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.resendApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.config.resendFromEmail,
        to: this.config.jobNotificationEmails,
        subject: "Action needed — Signmons intake was not saved",
        text: [
          "Signmons detected a webchat that appeared complete but did not create a service request.",
          `Session: ${sessionId}`,
          `Reason: ${reason}`,
          "Review the recent webchat conversation and contact the customer manually when contact details are available.",
        ].join("\n"),
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      throw new Error(`Resend returned HTTP ${response.status}.`);
    }

    this.loggingService.log(
      { event: "orphaned_intake_notification_sent", sessionId },
      JobNotificationService.name,
    );
  }

  private async deliver(
    job: JobRecord,
    kind: JobNotificationKind,
  ): Promise<NotificationDeliveryOutcome[]> {
    const deliveries: Array<{
      channel: NotificationChannel;
      send: () => Promise<void>;
    }> = [];
    const configurationOutcomes: NotificationDeliveryOutcome[] = [];

    if (this.config.jobNotificationEmails.length > 0) {
      if (this.config.resendApiKey && this.config.resendFromEmail) {
        deliveries.push({
          channel: "email",
          send: () => this.sendEmail(job, kind),
        });
      } else {
        this.logConfigurationWarning(job.id, "email");
        configurationOutcomes.push({
          channel: "email",
          recipientGroup: "operations",
          outcome: "misconfigured",
        });
      }
    }

    if (this.config.jobNotificationSmsNumbers.length > 0) {
      if (
        this.config.twilioAccountSid &&
        this.config.twilioAuthToken &&
        this.config.twilioPhoneNumber
      ) {
        deliveries.push({
          channel: "sms",
          send: () => this.sendSms(job, kind),
        });
      } else {
        this.logConfigurationWarning(job.id, "sms");
        configurationOutcomes.push({
          channel: "sms",
          recipientGroup: "operations",
          outcome: "misconfigured",
        });
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
      return configurationOutcomes.length
        ? configurationOutcomes
        : [
            {
              channel: "internal",
              recipientGroup: "operations",
              outcome: "not_configured",
            },
          ];
    }

    const results = await Promise.allSettled(
      deliveries.map((delivery) => delivery.send()),
    );

    const deliveryOutcomes = results.map((result, index) => {
      const channel = deliveries[index].channel;
      if (result.status === "fulfilled") {
        this.loggingService.log(
          { event: "job_notification_sent", channel, jobId: job.id },
          JobNotificationService.name,
        );
        return {
          channel,
          recipientGroup: "operations" as const,
          outcome: "delivered" as const,
        };
      }

      this.loggingService.error(
        `New-job ${channel} notification failed for job ${job.id}.`,
        result.reason instanceof Error ? result.reason : undefined,
        JobNotificationService.name,
      );
      return {
        channel,
        recipientGroup: "operations" as const,
        outcome: "failed" as const,
      };
    });
    return [...configurationOutcomes, ...deliveryOutcomes];
  }

  private async sendEmail(
    job: JobRecord,
    kind: JobNotificationKind,
  ): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.resendApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.config.resendFromEmail,
        to: this.config.jobNotificationEmails,
        subject: this.subject(job, kind),
        text: this.buildPlainText(job, kind),
        html: this.buildHtml(job, kind),
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      throw new Error(`Resend returned HTTP ${response.status}.`);
    }
  }

  private async sendSms(
    job: JobRecord,
    kind: JobNotificationKind,
  ): Promise<void> {
    const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.twilioAccountSid)}/Messages.json`;
    const authorization = Buffer.from(
      `${this.config.twilioAccountSid}:${this.config.twilioAuthToken}`,
    ).toString("base64");
    const body = this.buildSms(job, kind);

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

  private buildPlainText(job: JobRecord, kind: JobNotificationKind): string {
    return [
      this.heading(kind),
      `Reference: ${this.reference(job.id)}`,
      `Customer: ${job.customerName}`,
      `Phone: ${job.phone}`,
      `Service: ${job.issueCategory}`,
      `Urgency: ${job.urgency}`,
      `Preferred time: ${job.preferredTimeText ?? job.preferredTime ?? "Not provided"}`,
      `Address: ${job.address ?? "Not provided"}`,
      `Details: ${job.description ?? "Not provided"}`,
      `Lead source: ${this.leadSource(job)}`,
      `Origin page: ${job.leadAttribution?.sourcePage ?? "Not recorded"}`,
      this.note(kind),
    ].join("\n");
  }

  private buildHtml(job: JobRecord, kind: JobNotificationKind): string {
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
      ["Lead source", this.leadSource(job)],
      ["Origin page", job.leadAttribution?.sourcePage ?? "Not recorded"],
    ]
      .map(
        ([label, value]) =>
          `<tr><th style="padding:8px 12px;text-align:left;background:#f1f5f8;color:#44536a">${escapeHtml(label)}</th><td style="padding:8px 12px;color:#0b2646">${escapeHtml(value)}</td></tr>`,
      )
      .join("");

    const heading = this.heading(kind);
    const note = this.note(kind);
    return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#0b2646"><div style="max-width:640px;border:1px solid #d9e1ec"><div style="padding:20px 24px;background:#0b2646;color:white;border-bottom:5px solid #f47a38"><strong>${heading}</strong></div><div style="padding:24px"><table style="width:100%;border-collapse:collapse">${rows}</table><p style="margin:20px 0 0;color:#667085">${note}</p><p><a href="tel:${escapeHtml(job.phone)}" style="display:inline-block;padding:12px 16px;background:#f47a38;color:#0b2646;text-decoration:none;font-weight:bold">Call customer</a></p></div></div></body></html>`;
  }

  private buildSms(job: JobRecord, kind: JobNotificationKind): string {
    const time = job.preferredTimeText ?? job.preferredTime ?? "not provided";
    if (kind === "appointment_confirmed") {
      return `CONFIRMED ${this.reference(job.id)}: ${job.customerName}, ${job.phone}, residential ${job.issueCategory} diagnostic, ${time}.`;
    }
    if (kind === "appointment_rescheduled") {
      return `RESCHEDULED ${this.reference(job.id)}: ${job.customerName}, ${job.phone}, now ${time}.`;
    }
    if (kind === "appointment_cancelled") {
      return `CANCELLED ${this.reference(job.id)}: ${job.customerName}, ${job.phone}, previous time ${time}.`;
    }
    if (kind === "urgency_escalated") {
      return `ESCALATED ${this.reference(job.id)}: ${job.issueCategory}, ${job.urgency}. Review this request in Signmons CallDesk.`;
    }
    return `New Signmons request ${this.reference(job.id)}: ${job.customerName}, ${job.phone}, ${job.issueCategory}, ${job.urgency}, preferred ${time}. Not yet confirmed.`;
  }

  private subject(job: JobRecord, kind: JobNotificationKind): string {
    if (kind === "appointment_confirmed") {
      return `Appointment confirmed — ${job.customerName}`;
    }
    if (kind === "appointment_rescheduled") {
      return `Appointment rescheduled — ${job.customerName}`;
    }
    if (kind === "appointment_cancelled") {
      return `Appointment cancelled — ${job.customerName}`;
    }
    if (kind === "urgency_escalated") {
      return `${job.urgency} request escalated — ${this.reference(job.id)}`;
    }
    return `${job.urgency === "EMERGENCY" ? "URGENT: " : ""}New Signmons request — ${job.issueCategory}`;
  }

  private heading(kind: JobNotificationKind): string {
    if (kind === "appointment_confirmed") {
      return "Residential diagnostic appointment confirmed by Signmons";
    }
    if (kind === "appointment_rescheduled") {
      return "Residential diagnostic appointment rescheduled by customer";
    }
    if (kind === "appointment_cancelled") {
      return "Residential diagnostic appointment cancelled by customer";
    }
    if (kind === "urgency_escalated") {
      return "Urgency escalation from Signmons CallDesk";
    }
    return "New service request created by Signmons";
  }

  private note(kind: JobNotificationKind): string {
    if (kind === "appointment_confirmed") {
      return "This appointment was instantly confirmed from live calendar availability.";
    }
    if (kind === "appointment_rescheduled") {
      return "The customer changed this appointment through the secure website link. Eternity Dispatch has been updated.";
    }
    if (kind === "appointment_cancelled") {
      return "The customer cancelled this appointment through the secure website link. The calendar time has been released.";
    }
    if (kind === "urgency_escalated") {
      return "An authorized operator escalated this request. Review the job in CallDesk and record the operational outcome.";
    }
    return "The requested time is a preference and is not a confirmed appointment.";
  }

  private reference(jobId: string): string {
    return jobId.replace(/-/g, "").slice(0, 8).toUpperCase();
  }

  private leadSource(job: JobRecord): string {
    const attribution = job.leadAttribution;
    if (!attribution) return "Not recorded";
    if (attribution.utmSource) {
      return [
        attribution.utmSource,
        attribution.utmMedium,
        attribution.utmCampaign,
      ]
        .filter(Boolean)
        .join(" / ");
    }
    return attribution.referrerHost || "Direct website chat";
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
