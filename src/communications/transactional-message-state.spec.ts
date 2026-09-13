import { JobStatus, TechnicianJobStatus } from "@prisma/client";
import { TransactionalMessageTemplateKey as Template } from "./transactional-message-template.service";
import {
  evaluateTransactionalMessageState,
  type TransactionalMessageJob,
} from "./transactional-message-state";

describe("legacy reservation messaging hold", () => {
  const start = new Date("2026-09-10T12:00:00Z");
  const end = new Date("2026-09-10T14:00:00Z");
  const job: TransactionalMessageJob = {
    id: "fixture",
    status: JobStatus.ACCEPTED,
    deletedAt: null,
    technicianStatus: TechnicianJobStatus.EN_ROUTE,
    technicianStatusUpdatedAt: start,
    calendarEventId: null,
    serviceWindowStart: start,
    serviceWindowEnd: end,
    calendarOperations: [],
    tenant: { settings: {}, name: "Fixture", timezone: "UTC" },
    customer: { phone: "+15555550123" },
    assignedUser: { id: "tech", fullName: "Fixture Tech" },
  };
  it.each(Object.values(Template))(
    "holds %s for null, empty and whitespace references with full or partial windows",
    (template) => {
      for (const calendarEventId of [null, "", " \t "]) {
        for (const window of [
          { serviceWindowStart: start, serviceWindowEnd: end },
          { serviceWindowStart: start, serviceWindowEnd: null },
          { serviceWindowStart: null, serviceWindowEnd: end },
        ]) {
          expect(
            evaluateTransactionalMessageState(template, {
              ...job,
              ...window,
              calendarEventId,
            }),
          ).toBe("CALENDAR_PENDING");
        }
      }
    },
  );
  it("keeps missing and deleted jobs missing before reservation disclosure", () => {
    expect(
      evaluateTransactionalMessageState(Template.TECHNICIAN_ON_THE_WAY, null),
    ).toBe("MISSING");
    expect(
      evaluateTransactionalMessageState(Template.TECHNICIAN_ON_THE_WAY, {
        ...job,
        deletedAt: start,
      }),
    ).toBe("MISSING");
  });
  it("preserves unscheduled departure compatibility without asserting confirmation", () => {
    expect(
      evaluateTransactionalMessageState(Template.TECHNICIAN_ON_THE_WAY, {
        ...job,
        serviceWindowStart: null,
        serviceWindowEnd: null,
      }),
    ).toBe("AVAILABLE");
  });
  it("preserves terminal cancellation and rejects terminal departure", () => {
    expect(
      evaluateTransactionalMessageState(Template.APPOINTMENT_CANCELLED, {
        ...job,
        status: JobStatus.CANCELLED,
      }),
    ).toBe("AVAILABLE");
    for (const status of [JobStatus.CANCELLED, JobStatus.COMPLETED]) {
      expect(
        evaluateTransactionalMessageState(Template.TECHNICIAN_ON_THE_WAY, {
          ...job,
          status,
        }),
      ).toBe("INCOMPATIBLE");
    }
  });
  it("removes only the legacy hold when a reference is present", () => {
    const finalized = { ...job, calendarEventId: "fixture-event" };
    expect(
      evaluateTransactionalMessageState(
        Template.TECHNICIAN_ON_THE_WAY,
        finalized,
      ),
    ).toBe("AVAILABLE");
    expect(
      evaluateTransactionalMessageState(
        Template.APPOINTMENT_CONFIRMED,
        finalized,
      ),
    ).toBe("AVAILABLE");
    expect(
      evaluateTransactionalMessageState(Template.APPOINTMENT_CONFIRMED, {
        ...finalized,
        serviceWindowEnd: null,
      }),
    ).toBe("INCOMPATIBLE");
    expect(
      evaluateTransactionalMessageState(Template.TECHNICIAN_ON_THE_WAY, {
        ...finalized,
        calendarOperations: [{ id: "unfinished" }],
      }),
    ).toBe("CALENDAR_PENDING");
  });
});
