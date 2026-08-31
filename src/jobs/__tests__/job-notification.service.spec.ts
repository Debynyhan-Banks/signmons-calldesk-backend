import type { ConfigType } from "@nestjs/config";
import appConfig from "../../config/app.config";
import type { LoggingService } from "../../logging/logging.service";
import { JobNotificationService } from "../job-notification.service";
import type { JobRecord } from "../interfaces/job-repository.interface";

describe("JobNotificationService", () => {
  const job: JobRecord = {
    id: "a1b2c3d4-e5f6-4789-9012-345678901234",
    tenantId: "tenant-1",
    customerName: "Alice Example",
    phone: "+12165550123",
    address: "123 Main Street",
    issueCategory: "HEATING",
    urgency: "STANDARD",
    description: "Furnace is not heating.",
    preferredTime: "EVENING",
    preferredTimeText: "Tuesday after 5",
    status: "CREATED",
    createdAt: new Date("2026-08-29T12:00:00Z"),
    updatedAt: new Date("2026-08-29T12:00:00Z"),
    leadAttribution: {
      channel: "website_chat",
      landingPage: "/resources/furnace-repair-vs-replacement",
      sourcePage: "/services/furnace-heating-repair",
      referrerHost: "www.google.com",
      utmSource: "google",
      utmMedium: "organic",
    },
  };

  let loggingService: {
    log: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
  };
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    loggingService = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    fetchSpy = jest.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("emails configured recipients with the original time wording", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }));
    const service = createService({
      resendApiKey: "resend-test-key",
      resendFromEmail: "Eternity <requests@mail.eternityhvacr.com>",
      jobNotificationEmails: ["ben@eternityhvacr.com"],
    });

    await service.notifyJobCreated(job);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, request] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    const requestBody = typeof request?.body === "string" ? request.body : "";
    const payload = JSON.parse(requestBody) as {
      to: string[];
      text: string;
      subject: string;
    };
    expect(payload.to).toEqual(["ben@eternityhvacr.com"]);
    expect(payload.text).toContain("Preferred time: Tuesday after 5");
    expect(payload.text).toContain("Reference: A1B2C3D4");
    expect(payload.text).toContain("Lead source: google / organic");
    expect(payload.text).toContain(
      "Origin page: /services/furnace-heating-repair",
    );
    expect(loggingService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "job_notification_sent",
        channel: "email",
      }),
      "JobNotificationService",
    );
  });

  it("can text configured recipients through Twilio", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 201 }));
    const service = createService({
      twilioAccountSid: "AC123",
      twilioAuthToken: "twilio-test-token",
      twilioPhoneNumber: "+12165550000",
      jobNotificationSmsNumbers: ["+12167033183"],
    });

    await service.notifyJobCreated(job);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, request] = fetchSpy.mock.calls[0];
    const requestUrl = typeof url === "string" ? url : url.url;
    const requestBody = typeof request?.body === "string" ? request.body : "";
    expect(requestUrl).toContain("api.twilio.com");
    expect(requestBody).toContain("To=%2B12167033183");
    expect(requestBody).toContain("Tuesday+after+5");
  });

  it("does not fail job creation when a provider is temporarily unavailable", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 503 }));
    const service = createService({
      resendApiKey: "resend-test-key",
      resendFromEmail: "Eternity <requests@mail.eternityhvacr.com>",
      jobNotificationEmails: ["ben@eternityhvacr.com"],
    });

    await expect(service.notifyJobCreated(job)).resolves.toBeUndefined();
    expect(loggingService.error).toHaveBeenCalledWith(
      expect.stringContaining("email notification failed"),
      expect.any(Error),
      "JobNotificationService",
    );
  });

  it("warns when no delivery channel is configured", async () => {
    const service = createService({});

    await service.notifyJobCreated(job);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loggingService.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "job_notification_not_configured" }),
      "JobNotificationService",
    );
  });

  it("emails operations when a completed-looking intake was not saved", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }));
    const service = createService({
      resendApiKey: "resend-test-key",
      resendFromEmail: "Eternity <requests@mail.eternityhvacr.com>",
      jobNotificationEmails: ["ben@eternityhvacr.com"],
    });

    await service.notifyOrphanedIntake(
      "session-1234",
      "automatic finalization failed",
    );

    const [, request] = fetchSpy.mock.calls[0];
    const requestBody = typeof request?.body === "string" ? request.body : "";
    const payload = JSON.parse(requestBody) as {
      subject: string;
      text: string;
    };
    expect(payload.subject).toContain("intake was not saved");
    expect(payload.text).toContain("Session: session-1234");
    expect(loggingService.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "orphaned_intake_notification_sent" }),
      "JobNotificationService",
    );
  });

  it("sends one clear reschedule notification with the new confirmed time", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }));
    const service = createService({
      resendApiKey: "resend-test-key",
      resendFromEmail: "Eternity <requests@mail.eternityhvacr.com>",
      jobNotificationEmails: ["ben@eternityhvacr.com"],
    });

    await service.notifyAppointmentRescheduled({
      ...job,
      preferredTimeText: "Thursday, September 3, 11:00 AM–2:00 PM",
    });

    const [, request] = fetchSpy.mock.calls[0];
    const payload = JSON.parse(
      typeof request?.body === "string" ? request.body : "{}",
    ) as {
      subject: string;
      text: string;
    };
    expect(payload.subject).toBe("Appointment rescheduled — Alice Example");
    expect(payload.text).toContain("Thursday, September 3, 11:00 AM–2:00 PM");
    expect(payload.text).toContain("Eternity Dispatch has been updated");
  });

  it("sends one cancellation notification confirming the slot was released", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }));
    const service = createService({
      resendApiKey: "resend-test-key",
      resendFromEmail: "Eternity <requests@mail.eternityhvacr.com>",
      jobNotificationEmails: ["ben@eternityhvacr.com"],
    });

    await service.notifyAppointmentCancelled(job);

    const [, request] = fetchSpy.mock.calls[0];
    const payload = JSON.parse(
      typeof request?.body === "string" ? request.body : "{}",
    ) as {
      subject: string;
      text: string;
    };
    expect(payload.subject).toBe("Appointment cancelled — Alice Example");
    expect(payload.text).toContain("calendar time has been released");
  });

  function createService(
    overrides: Partial<ConfigType<typeof appConfig>>,
  ): JobNotificationService {
    const config = {
      resendApiKey: "",
      resendFromEmail: "",
      jobNotificationEmails: [],
      twilioAccountSid: "",
      twilioAuthToken: "",
      twilioPhoneNumber: "",
      jobNotificationSmsNumbers: [],
      ...overrides,
    } as ConfigType<typeof appConfig>;

    return new JobNotificationService(
      config,
      loggingService as unknown as LoggingService,
    );
  }
});
