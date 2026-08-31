import { createHmac, timingSafeEqual } from "crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import { GoogleAuth } from "google-auth-library";
import { JobStatus, Prisma } from "@prisma/client";
import appConfig from "../config/app.config";
import { JobNotificationService } from "../jobs/job-notification.service";
import type { JobRecord } from "../jobs/interfaces/job-repository.interface";
import { LoggingService } from "../logging/logging.service";
import { PrismaService } from "../prisma/prisma.service";

export interface AppointmentSlot {
  token: string;
  start: string;
  end: string;
  label: string;
}

interface SignedSlot {
  tenantId: string;
  jobId: string;
  start: string;
  end: string;
  expiresAt: number;
}

interface SignedAppointmentManagement {
  version: 1;
  purpose: "appointment-management";
  tenantId: string;
  jobId: string;
  expiresAt: number;
}

interface BusyPeriod {
  start: string;
  end: string;
}

type AppointmentJob = Prisma.JobGetPayload<{
  include: {
    customer: true;
    propertyAddress: true;
    serviceCategory: true;
  };
}>;

const SERVICE_WINDOWS = [
  { label: "8–11 AM", start: "08:00", end: "11:00" },
  { label: "11 AM–2 PM", start: "11:00", end: "14:00" },
  { label: "2–5 PM", start: "14:00", end: "17:00" },
] as const;

@Injectable()
export class SchedulingService {
  private readonly auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: JobNotificationService,
    private readonly loggingService: LoggingService,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  isInstantBookingEligible(job: JobRecord): boolean {
    return (
      this.config.schedulingEnabled &&
      job.propertyType === "RESIDENTIAL" &&
      ["DIAGNOSTIC", "REPAIR"].includes(job.serviceIntent) &&
      job.urgency === "STANDARD" &&
      Boolean(job.address && job.address !== "Unknown address") &&
      ["HEATING", "COOLING"].includes(job.issueCategory)
    );
  }

  async getAvailableSlots(job: JobRecord): Promise<AppointmentSlot[]> {
    if (!this.isInstantBookingEligible(job)) return [];

    const now = new Date();
    const candidates = this.buildCandidates(now);
    if (!candidates.length) return [];
    const rangeStart = candidates[0].start;
    const rangeEnd = candidates[candidates.length - 1].end;
    const [calendarBusy, reservedJobs] = await Promise.all([
      this.fetchBusy(rangeStart, rangeEnd),
      this.prisma.job.findMany({
        where: {
          tenantId: job.tenantId,
          status: JobStatus.ACCEPTED,
          serviceWindowStart: { lt: rangeEnd },
          serviceWindowEnd: { gt: rangeStart },
        },
        select: { serviceWindowStart: true, serviceWindowEnd: true },
      }),
    ]);
    const busy = [
      ...calendarBusy,
      ...reservedJobs.flatMap((reserved) =>
        reserved.serviceWindowStart && reserved.serviceWindowEnd
          ? [
              {
                start: reserved.serviceWindowStart.toISOString(),
                end: reserved.serviceWindowEnd.toISOString(),
              },
            ]
          : [],
      ),
    ];

    return candidates
      .filter(({ start, end }) => !this.overlapsBusy(start, end, busy))
      .slice(0, 8)
      .map(({ start, end, label }) => ({
        start: start.toISOString(),
        end: end.toISOString(),
        label,
        token: this.signSlot({
          tenantId: job.tenantId,
          jobId: job.id,
          start: start.toISOString(),
          end: end.toISOString(),
          expiresAt: Date.now() + 30 * 60 * 1000,
        }),
      }));
  }

  async confirmAppointment(input: {
    tenantId: string;
    sessionId: string;
    jobId: string;
    slotToken: string;
  }) {
    if (!this.config.schedulingEnabled) {
      throw new ServiceUnavailableException(
        "Instant appointment booking is temporarily unavailable.",
      );
    }
    const slot = this.verifySlot(input.slotToken);
    if (slot.tenantId !== input.tenantId || slot.jobId !== input.jobId) {
      throw new BadRequestException("This appointment choice is invalid.");
    }

    const job = await this.prisma.job.findFirst({
      where: {
        id: input.jobId,
        tenantId: input.tenantId,
        intakeSessionId: input.sessionId,
      },
      include: {
        customer: true,
        propertyAddress: true,
        serviceCategory: true,
      },
    });
    if (!job) throw new BadRequestException("Service request not found.");
    const record = this.mapJob(job);
    if (!this.isInstantBookingEligible(record)) {
      throw new BadRequestException(
        "This service request requires confirmation from Eternity.",
      );
    }

    const start = new Date(slot.start);
    const end = new Date(slot.end);
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      start >= end
    ) {
      throw new BadRequestException("This appointment choice is invalid.");
    }
    if (
      job.status === JobStatus.ACCEPTED &&
      job.serviceWindowStart?.getTime() === start.getTime() &&
      job.serviceWindowEnd?.getTime() === end.getTime()
    ) {
      return this.confirmedResponse(this.mapJob(job));
    }

    const busy = await this.fetchBusy(start, end);
    if (this.overlapsBusy(start, end, busy)) {
      throw new ConflictException(
        "That appointment was just taken. Please choose another time.",
      );
    }

    try {
      const reservation = await this.prisma.job.updateMany({
        where: {
          id: job.id,
          tenantId: job.tenantId,
          serviceWindowStart: null,
          serviceWindowEnd: null,
        },
        data: {
          status: JobStatus.ACCEPTED,
          serviceWindowStart: start,
          serviceWindowEnd: end,
          preferredTimeText: this.formatWindow(start, end),
        },
      });
      if (reservation.count !== 1) {
        throw new ConflictException(
          "This request already has an appointment selection.",
        );
      }
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "That appointment was just taken. Please choose another time.",
        );
      }
      throw error;
    }

    try {
      const calendarEventId = await this.insertCalendarEvent(
        record,
        start,
        end,
      );
      const confirmed = await this.prisma.job.update({
        where: { id: job.id },
        data: { calendarEventId },
        include: {
          customer: true,
          propertyAddress: true,
          serviceCategory: true,
        },
      });
      const confirmedRecord = this.mapJob(confirmed);
      this.notifications.enqueueAppointmentConfirmed(confirmedRecord);
      return this.confirmedResponse(confirmedRecord);
    } catch (error) {
      await this.prisma.job.updateMany({
        where: { id: job.id, tenantId: job.tenantId, calendarEventId: null },
        data: {
          status: JobStatus.CREATED,
          serviceWindowStart: null,
          serviceWindowEnd: null,
          preferredTimeText: null,
        },
      });
      this.loggingService.error(
        `Calendar reservation failed for job ${job.id}.`,
        error instanceof Error ? error : undefined,
        SchedulingService.name,
      );
      throw new ServiceUnavailableException(
        "We could not reserve that time. Please try another appointment.",
      );
    }
  }

  async manageAppointment(input: {
    tenantId: string;
    managementToken: string;
    action: "view" | "availability" | "reschedule" | "cancel";
    slotToken?: string;
  }) {
    const authority = this.verifyManagementToken(
      input.managementToken,
      input.tenantId,
    );
    const job = await this.loadAppointment(authority.tenantId, authority.jobId);
    const record = this.mapJob(job);

    if (input.action === "view") {
      return this.managementResponse(record);
    }

    if (input.action === "cancel") {
      return this.cancelAppointment(job);
    }

    if (
      job.status !== JobStatus.ACCEPTED ||
      !job.calendarEventId ||
      !job.serviceWindowStart ||
      !job.serviceWindowEnd
    ) {
      throw new ConflictException(
        "This appointment can no longer be changed online. Please call Eternity.",
      );
    }

    if (input.action === "availability") {
      const slots = await this.getAvailableSlots(record);
      return {
        status: "appointment_availability" as const,
        appointment: this.appointmentSummary(record),
        slots,
      };
    }

    if (!input.slotToken) {
      throw new BadRequestException("Choose a new appointment time.");
    }
    return this.rescheduleAppointment(job, record, input.slotToken);
  }

  private confirmedResponse(job: JobRecord) {
    return {
      status: "appointment_confirmed" as const,
      job,
      appointment: this.appointmentSummary(job),
      managementToken: this.signManagementToken(job),
    };
  }

  private managementResponse(job: JobRecord) {
    return {
      status: "appointment_details" as const,
      state: job.status === "CANCELLED" ? "cancelled" : "confirmed",
      reference: this.reference(job.id),
      appointment: this.appointmentSummary(job),
    };
  }

  private appointmentSummary(job: JobRecord) {
    return {
      start: job.serviceWindowStart?.toISOString(),
      end: job.serviceWindowEnd?.toISOString(),
      label:
        job.serviceWindowStart && job.serviceWindowEnd
          ? this.formatWindow(job.serviceWindowStart, job.serviceWindowEnd)
          : (job.preferredTimeText ?? "Cancelled"),
    };
  }

  private async rescheduleAppointment(
    job: AppointmentJob,
    record: JobRecord,
    slotToken: string,
  ) {
    const slot = this.verifySlot(slotToken);
    if (slot.tenantId !== job.tenantId || slot.jobId !== job.id) {
      throw new BadRequestException("This appointment choice is invalid.");
    }
    const start = new Date(slot.start);
    const end = new Date(slot.end);
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      start >= end
    ) {
      throw new BadRequestException("This appointment choice is invalid.");
    }
    if (
      job.serviceWindowStart?.getTime() === start.getTime() &&
      job.serviceWindowEnd?.getTime() === end.getTime()
    ) {
      return {
        status: "appointment_rescheduled" as const,
        reference: this.reference(job.id),
        appointment: this.appointmentSummary(record),
      };
    }
    const busy = await this.fetchBusy(start, end);
    if (this.overlapsBusy(start, end, busy)) {
      throw new ConflictException(
        "That appointment was just taken. Please choose another time.",
      );
    }

    const originalStart = job.serviceWindowStart;
    const originalEnd = job.serviceWindowEnd;
    const originalTimeText = job.preferredTimeText;
    const calendarEventId = job.calendarEventId;
    if (!calendarEventId) {
      throw new ConflictException(
        "This appointment can no longer be changed online. Please call Eternity.",
      );
    }
    try {
      const reservation = await this.prisma.job.updateMany({
        where: {
          id: job.id,
          tenantId: job.tenantId,
          status: JobStatus.ACCEPTED,
          calendarEventId,
          serviceWindowStart: originalStart,
          serviceWindowEnd: originalEnd,
        },
        data: {
          serviceWindowStart: start,
          serviceWindowEnd: end,
          preferredTimeText: this.formatWindow(start, end),
        },
      });
      if (reservation.count !== 1) {
        throw new ConflictException(
          "This appointment changed while you were viewing it. Please refresh.",
        );
      }
      await this.updateCalendarEvent(calendarEventId, start, end);
      const updatedRecord: JobRecord = {
        ...record,
        serviceWindowStart: start,
        serviceWindowEnd: end,
        preferredTimeText: this.formatWindow(start, end),
        updatedAt: new Date(),
      };
      this.notifications.enqueueAppointmentRescheduled(updatedRecord);
      return {
        status: "appointment_rescheduled" as const,
        reference: this.reference(job.id),
        appointment: this.appointmentSummary(updatedRecord),
      };
    } catch (error) {
      await this.prisma.job.updateMany({
        where: {
          id: job.id,
          tenantId: job.tenantId,
          calendarEventId,
          serviceWindowStart: start,
          serviceWindowEnd: end,
        },
        data: {
          serviceWindowStart: originalStart,
          serviceWindowEnd: originalEnd,
          preferredTimeText: originalTimeText,
        },
      });
      if (error instanceof ConflictException) throw error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "That appointment was just taken. Please choose another time.",
        );
      }
      this.loggingService.error(
        `Appointment reschedule failed for job ${job.id}.`,
        error instanceof Error ? error : undefined,
        SchedulingService.name,
      );
      throw new ServiceUnavailableException(
        "We could not change that appointment. Your original time is still reserved.",
      );
    }
  }

  private async cancelAppointment(job: AppointmentJob) {
    if (job.status === JobStatus.CANCELLED) {
      return {
        status: "appointment_cancelled" as const,
        reference: this.reference(job.id),
      };
    }
    if (
      job.status !== JobStatus.ACCEPTED ||
      !job.calendarEventId ||
      !job.serviceWindowStart ||
      !job.serviceWindowEnd
    ) {
      throw new ConflictException(
        "This appointment can no longer be cancelled online. Please call Eternity.",
      );
    }

    const eventId = job.calendarEventId;
    const originalStart = job.serviceWindowStart;
    const originalEnd = job.serviceWindowEnd;
    const originalTimeText =
      job.preferredTimeText ?? this.formatWindow(originalStart, originalEnd);
    const cancellation = await this.prisma.job.updateMany({
      where: {
        id: job.id,
        tenantId: job.tenantId,
        status: JobStatus.ACCEPTED,
        calendarEventId: eventId,
        serviceWindowStart: originalStart,
        serviceWindowEnd: originalEnd,
      },
      data: {
        status: JobStatus.CANCELLED,
        calendarEventId: null,
        serviceWindowStart: null,
        serviceWindowEnd: null,
        preferredTimeText: originalTimeText,
      },
    });
    if (cancellation.count !== 1) {
      throw new ConflictException(
        "This appointment changed while you were viewing it. Please refresh.",
      );
    }

    try {
      await this.deleteCalendarEvent(eventId);
      this.notifications.enqueueAppointmentCancelled({
        ...this.mapJob(job),
        status: "CANCELLED",
        calendarEventId: undefined,
        serviceWindowStart: undefined,
        serviceWindowEnd: undefined,
        preferredTimeText: originalTimeText,
        updatedAt: new Date(),
      });
      return {
        status: "appointment_cancelled" as const,
        reference: this.reference(job.id),
      };
    } catch (error) {
      await this.prisma.job.updateMany({
        where: {
          id: job.id,
          tenantId: job.tenantId,
          status: JobStatus.CANCELLED,
          calendarEventId: null,
        },
        data: {
          status: JobStatus.ACCEPTED,
          calendarEventId: eventId,
          serviceWindowStart: originalStart,
          serviceWindowEnd: originalEnd,
          preferredTimeText: originalTimeText,
        },
      });
      this.loggingService.error(
        `Appointment cancellation failed for job ${job.id}.`,
        error instanceof Error ? error : undefined,
        SchedulingService.name,
      );
      throw new ServiceUnavailableException(
        "We could not cancel that appointment. It remains scheduled; please call Eternity.",
      );
    }
  }

  private buildCandidates(now: Date) {
    const minimum = new Date(
      now.getTime() + this.config.schedulingMinNoticeMinutes * 60_000,
    );
    const firstDate = this.dateKeyInZone(now);
    const slots: Array<{ start: Date; end: Date; label: string }> = [];
    for (
      let offset = 0;
      offset < this.config.schedulingLookaheadDays;
      offset++
    ) {
      const dateKey = this.addDays(firstDate, offset);
      const weekday = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      for (const window of SERVICE_WINDOWS) {
        const start = this.zonedTime(dateKey, window.start);
        const end = this.zonedTime(dateKey, window.end);
        if (start < minimum) continue;
        slots.push({
          start,
          end,
          label: `${new Intl.DateTimeFormat("en-US", {
            timeZone: this.config.schedulingTimeZone,
            weekday: "short",
            month: "short",
            day: "numeric",
          }).format(start)}, ${window.label}`,
        });
      }
    }
    return slots;
  }

  private async fetchBusy(start: Date, end: Date): Promise<BusyPeriod[]> {
    const headers = await this.authorizationHeaders();
    const response = await fetch(
      "https://www.googleapis.com/calendar/v3/freeBusy",
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          timeZone: this.config.schedulingTimeZone,
          items: [{ id: this.config.googleCalendarId }],
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) {
      throw new ServiceUnavailableException(
        "Appointment availability is temporarily unavailable.",
      );
    }
    const payload = (await response.json()) as {
      calendars?: Record<string, { busy?: BusyPeriod[]; errors?: unknown[] }>;
    };
    const calendar = payload.calendars?.[this.config.googleCalendarId];
    if (!calendar || calendar.errors?.length) {
      throw new ServiceUnavailableException(
        "Appointment availability is temporarily unavailable.",
      );
    }
    return calendar.busy ?? [];
  }

  private async insertCalendarEvent(
    job: JobRecord,
    start: Date,
    end: Date,
  ): Promise<string> {
    const headers = await this.authorizationHeaders();
    const calendarId = encodeURIComponent(this.config.googleCalendarId);
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          summary: `Residential diagnostic — ${job.customerName}`,
          description: [
            `Signmons reference: ${this.reference(job.id)}`,
            `Phone: ${job.phone}`,
            `Service: ${job.issueCategory}`,
            `Issue: ${job.description ?? "Not provided"}`,
          ].join("\n"),
          location: job.address,
          start: {
            dateTime: start.toISOString(),
            timeZone: this.config.schedulingTimeZone,
          },
          end: {
            dateTime: end.toISOString(),
            timeZone: this.config.schedulingTimeZone,
          },
          extendedProperties: {
            private: { signmonsJobId: job.id, signmonsTenantId: job.tenantId },
          },
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Google Calendar returned HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as { id?: string };
    if (!payload.id) throw new Error("Google Calendar event ID is missing.");
    return payload.id;
  }

  private async updateCalendarEvent(
    eventId: string,
    start: Date,
    end: Date,
  ): Promise<void> {
    const headers = await this.authorizationHeaders();
    const calendarId = encodeURIComponent(this.config.googleCalendarId);
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`,
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          start: {
            dateTime: start.toISOString(),
            timeZone: this.config.schedulingTimeZone,
          },
          end: {
            dateTime: end.toISOString(),
            timeZone: this.config.schedulingTimeZone,
          },
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Google Calendar returned HTTP ${response.status}.`);
    }
  }

  private async deleteCalendarEvent(eventId: string): Promise<void> {
    const headers = await this.authorizationHeaders();
    const calendarId = encodeURIComponent(this.config.googleCalendarId);
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`,
      {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Google Calendar returned HTTP ${response.status}.`);
    }
  }

  private async loadAppointment(
    tenantId: string,
    jobId: string,
  ): Promise<AppointmentJob> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, tenantId },
      include: {
        customer: true,
        propertyAddress: true,
        serviceCategory: true,
      },
    });
    if (!job) throw new BadRequestException("Appointment not found.");
    return job;
  }

  private async authorizationHeaders(): Promise<Record<string, string>> {
    const client = await this.auth.getClient();
    const headers = await client.getRequestHeaders();
    return Object.fromEntries(headers.entries());
  }

  private overlapsBusy(start: Date, end: Date, busy: BusyPeriod[]): boolean {
    return busy.some((period) => {
      const busyStart = new Date(period.start);
      const busyEnd = new Date(period.end);
      return start < busyEnd && end > busyStart;
    });
  }

  private signSlot(payload: SignedSlot): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac(
      "sha256",
      this.config.conversationDataEncryptionKey,
    )
      .update(encoded)
      .digest("base64url");
    return `${encoded}.${signature}`;
  }

  private signManagementToken(job: JobRecord): string {
    return this.signPayload({
      version: 1,
      purpose: "appointment-management",
      tenantId: job.tenantId,
      jobId: job.id,
      expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
    });
  }

  private verifyManagementToken(
    token: string,
    tenantId: string,
  ): SignedAppointmentManagement {
    const payload = this.verifySignedPayload(token);
    if (
      payload.version !== 1 ||
      payload.purpose !== "appointment-management" ||
      typeof payload.tenantId !== "string" ||
      typeof payload.jobId !== "string" ||
      typeof payload.expiresAt !== "number" ||
      payload.tenantId !== tenantId ||
      payload.expiresAt < Date.now()
    ) {
      throw new BadRequestException(
        "This appointment link is invalid or has expired.",
      );
    }
    return payload as unknown as SignedAppointmentManagement;
  }

  private signPayload(payload: Record<string, unknown>): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac(
      "sha256",
      this.config.conversationDataEncryptionKey,
    )
      .update(encoded)
      .digest("base64url");
    return `${encoded}.${signature}`;
  }

  private verifySignedPayload(token: string): Record<string, unknown> {
    const [encoded, suppliedSignature] = token.split(".");
    if (!encoded || !suppliedSignature) {
      throw new BadRequestException(
        "This appointment link is invalid or has expired.",
      );
    }
    const expectedSignature = createHmac(
      "sha256",
      this.config.conversationDataEncryptionKey,
    )
      .update(encoded)
      .digest("base64url");
    const supplied = Buffer.from(suppliedSignature);
    const expected = Buffer.from(expectedSignature);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new BadRequestException(
        "This appointment link is invalid or has expired.",
      );
    }
    try {
      const payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as unknown;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Invalid payload");
      }
      return payload as Record<string, unknown>;
    } catch {
      throw new BadRequestException(
        "This appointment link is invalid or has expired.",
      );
    }
  }

  private verifySlot(token: string): SignedSlot {
    const [encoded, suppliedSignature] = token.split(".");
    if (!encoded || !suppliedSignature) {
      throw new BadRequestException("This appointment choice is invalid.");
    }
    const expectedSignature = createHmac(
      "sha256",
      this.config.conversationDataEncryptionKey,
    )
      .update(encoded)
      .digest("base64url");
    const supplied = Buffer.from(suppliedSignature);
    const expected = Buffer.from(expectedSignature);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new BadRequestException("This appointment choice is invalid.");
    }
    try {
      const payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as SignedSlot;
      if (payload.expiresAt < Date.now()) {
        throw new BadRequestException("This appointment choice has expired.");
      }
      return payload;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("This appointment choice is invalid.");
    }
  }

  private dateKeyInZone(date: Date): string {
    const parts = this.partsInZone(date);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  private addDays(dateKey: string, days: number): string {
    const [year, month, day] = dateKey.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return date.toISOString().slice(0, 10);
  }

  private zonedTime(dateKey: string, time: string): Date {
    const [year, month, day] = dateKey.split("-").map(Number);
    const [hour, minute] = time.split(":").map(Number);
    const desired = Date.UTC(year, month - 1, day, hour, minute);
    let guess = desired;
    for (let iteration = 0; iteration < 3; iteration++) {
      const parts = this.partsInZone(new Date(guess));
      const observed = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
      );
      guess += desired - observed;
    }
    return new Date(guess);
  }

  private partsInZone(date: Date): Record<string, string> {
    return Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: this.config.schedulingTimeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
  }

  private formatWindow(start: Date, end: Date): string {
    const date = new Intl.DateTimeFormat("en-US", {
      timeZone: this.config.schedulingTimeZone,
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(start);
    const times = new Intl.DateTimeFormat("en-US", {
      timeZone: this.config.schedulingTimeZone,
      hour: "numeric",
      minute: "2-digit",
    });
    return `${date}, ${times.format(start)}–${times.format(end)}`;
  }

  private mapJob(
    job: Prisma.JobGetPayload<{
      include: {
        customer: true;
        propertyAddress: true;
        serviceCategory: true;
      };
    }>,
  ): JobRecord {
    const snapshot =
      job.policySnapshot &&
      typeof job.policySnapshot === "object" &&
      !Array.isArray(job.policySnapshot)
        ? (job.policySnapshot as Record<string, unknown>)
        : {};
    return {
      id: job.id,
      tenantId: job.tenantId,
      customerName: job.customer.fullName,
      phone: job.customer.phone,
      address: job.propertyAddress.formattedAddress,
      issueCategory: job.serviceCategory.name,
      urgency: job.urgency,
      description: job.description ?? undefined,
      preferredTime: job.preferredWindowLabel ?? undefined,
      preferredTimeText: job.preferredTimeText ?? undefined,
      propertyType:
        snapshot.propertyType === "RESIDENTIAL" ||
        snapshot.propertyType === "COMMERCIAL"
          ? snapshot.propertyType
          : "MANAGED",
      serviceIntent:
        snapshot.serviceIntent === "DIAGNOSTIC" ||
        snapshot.serviceIntent === "REPAIR" ||
        snapshot.serviceIntent === "INSTALLATION" ||
        snapshot.serviceIntent === "MAINTENANCE"
          ? snapshot.serviceIntent
          : "OTHER",
      serviceWindowStart: job.serviceWindowStart ?? undefined,
      serviceWindowEnd: job.serviceWindowEnd ?? undefined,
      calendarEventId: job.calendarEventId ?? undefined,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private reference(jobId: string): string {
    return jobId.replace(/-/g, "").slice(0, 8).toUpperCase();
  }
}
