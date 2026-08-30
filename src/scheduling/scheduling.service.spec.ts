import { GoogleAuth } from "google-auth-library";
import type { AppConfig } from "../config/app.config";
import type { JobNotificationService } from "../jobs/job-notification.service";
import type { JobRecord } from "../jobs/interfaces/job-repository.interface";
import type { LoggingService } from "../logging/logging.service";
import type { PrismaService } from "../prisma/prisma.service";
import { SchedulingService } from "./scheduling.service";

describe("SchedulingService", () => {
  const config = {
    schedulingEnabled: true,
    googleCalendarId: "dispatch@example.com",
    schedulingTimeZone: "America/New_York",
    schedulingLookaheadDays: 14,
    schedulingMinNoticeMinutes: 120,
    conversationDataEncryptionKey: "a".repeat(64),
  } as AppConfig;
  const baseJob: JobRecord = {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    customerName: "Test Customer",
    phone: "+12165550100",
    address: "100 Test Street, Cleveland, OH",
    issueCategory: "COOLING",
    urgency: "STANDARD",
    description: "AC is blowing warm air",
    propertyType: "RESIDENTIAL",
    serviceIntent: "DIAGNOSTIC",
    status: "CREATED",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = {
    job: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const notifications = {
    enqueueAppointmentConfirmed: jest.fn(),
  };
  const logger = {
    error: jest.fn(),
  };

  let service: SchedulingService;

  beforeEach(() => {
    jest.restoreAllMocks();
    prisma.job.findMany.mockResolvedValue([]);
    service = new SchedulingService(
      prisma as unknown as PrismaService,
      notifications as unknown as JobNotificationService,
      logger as unknown as LoggingService,
      config,
    );
  });

  it("allows only complete standard residential heating or cooling diagnostics", () => {
    expect(service.isInstantBookingEligible(baseJob)).toBe(true);
    expect(
      service.isInstantBookingEligible({
        ...baseJob,
        propertyType: "COMMERCIAL",
      }),
    ).toBe(false);
    expect(
      service.isInstantBookingEligible({
        ...baseJob,
        serviceIntent: "INSTALLATION",
      }),
    ).toBe(false);
    expect(
      service.isInstantBookingEligible({ ...baseJob, urgency: "EMERGENCY" }),
    ).toBe(false);
    expect(
      service.isInstantBookingEligible({
        ...baseJob,
        address: "Unknown address",
      }),
    ).toBe(false);
  });

  it("returns signed weekday windows after excluding calendar conflicts", async () => {
    jest.spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue({
      getRequestHeaders: jest.fn().mockResolvedValue(
        new Headers({
          authorization: "Bearer test",
        }),
      ),
    } as never);
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        calendars: { "dispatch@example.com": { busy: [] } },
      }),
    } as never);

    const slots = await service.getAvailableSlots(baseJob);

    expect(slots).toHaveLength(8);
    expect(slots[0]).toEqual(
      expect.objectContaining({
        label: expect.stringMatching(/AM|PM/),
        token: expect.stringContaining("."),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.googleapis.com/calendar/v3/freeBusy",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
