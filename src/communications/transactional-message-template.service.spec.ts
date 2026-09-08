import { BadRequestException } from "@nestjs/common";
import {
  TransactionalMessageTemplateKey,
  TransactionalMessageTemplateService,
} from "./transactional-message-template.service";

describe("TransactionalMessageTemplateService", () => {
  const service = new TransactionalMessageTemplateService();

  it("renders a versioned, contractor-branded confirmation with compliance copy", () => {
    const result = service.render(
      TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED,
      {
        contractorName: "Eternity Mechanical",
        appointmentTime: new Date("2026-09-09T14:00:00.000Z"),
        timeZone: "America/New_York",
      },
    );

    expect(result).toEqual(
      expect.objectContaining({
        templateId: "transactional_sms:appointment_confirmed:v1",
        templateVersion: 1,
      }),
    );
    expect(result.body).toContain("Eternity Mechanical:");
    expect(result.body).toContain("Wed, Sep 9, 10:00 AM EDT");
    expect(result.body).toContain("Reply STOP to opt out or HELP for help.");
  });

  it("renders technician identity when it is available", () => {
    const result = service.render(
      TransactionalMessageTemplateKey.TECHNICIAN_ON_THE_WAY,
      {
        contractorName: "Example HVAC",
        timeZone: "America/New_York",
        technicianName: "Jordan",
      },
    );
    expect(result.body).toContain("Jordan, your technician, is on the way");
  });

  it("fails closed when an appointment template has no scheduled time", () => {
    expect(() =>
      service.render(TransactionalMessageTemplateKey.APPOINTMENT_RESCHEDULED, {
        contractorName: "Example HVAC",
        timeZone: "America/New_York",
      }),
    ).toThrow(BadRequestException);
  });
});
