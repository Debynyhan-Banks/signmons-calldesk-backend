import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { CalendarOperation } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JournaledAppointmentBookingService } from "./journaled-appointment-booking.service";
import {
  SchedulingService,
  InitialConfirmationInput,
} from "./scheduling.service";

type Preparation = Awaited<
  ReturnType<SchedulingService["prepareInitialConfirmation"]>
>;
describe("Inactive journaled booking composition", () => {
  const input: InitialConfirmationInput = {
    tenantId: "tenant",
    sessionId: "session",
    jobId: "job",
    slotToken: "signed",
  };
  const now = new Date("2038-01-01T12:00:00Z");
  const ready = {
    kind: "ready",
    job: { id: "canonical-job", tenantId: "canonical-tenant", updatedAt: now },
    start: now,
    end: new Date(now.getTime() + 3600000),
    label: "Canonical window",
  } as unknown as Preparation;
  const operation = {
    id: "durable-id",
    tenantId: "canonical-tenant",
    calendarEventId: "durable-event",
  } as CalendarOperation;
  const admission = {
    readInitialConfirmationReceipt: jest.fn(),
    prepareInitialConfirmation: jest.fn<
      Promise<Preparation>,
      [InitialConfirmationInput]
    >(),
  };
  const journal = { reserve: jest.fn().mockResolvedValue(operation) };
  const executor = {
    execute: jest.fn().mockResolvedValue({ status: "finalized" }),
  };
  let service: JournaledAppointmentBookingService;
  const receipt = {
    status: "appointment_confirmed",
    managementToken: "fresh-token",
  };
  beforeEach(() => {
    jest.resetAllMocks();
    admission.prepareInitialConfirmation.mockResolvedValue(ready);
    admission.readInitialConfirmationReceipt.mockResolvedValue(receipt);
    journal.reserve.mockResolvedValue(operation);
    executor.execute.mockResolvedValue({ status: "finalized" });
    service = new JournaledAppointmentBookingService(
      admission,
      journal,
      executor,
      {
        googleCalendarId: "server@example.invalid",
        schedulingTimeZone: "UTC",
      },
    );
  });
  it("uses canonical preflight and server routing, then executes only the acknowledged journal", async () => {
    const untrusted = {
      ...input,
      calendarId: "attacker",
      operationId: "attacker",
      paid: true,
    };
    expect(await service.book(untrusted)).toEqual(receipt);
    expect(admission.readInitialConfirmationReceipt).toHaveBeenCalledWith(
      untrusted,
      {
        operationId: "durable-id",
        calendarEventId: "durable-event",
      },
    );
    expect(admission.prepareInitialConfirmation).toHaveBeenCalledWith(
      untrusted,
    );
    expect(journal.reserve).toHaveBeenCalledWith({
      tenantId: "canonical-tenant",
      jobId: "canonical-job",
      expectedUpdatedAt: now,
      action: "CREATE",
      start: now,
      end: new Date(now.getTime() + 3600000),
      label: "Canonical window",
      calendarId: "server@example.invalid",
      timeZone: "UTC",
    });
    expect(executor.execute).toHaveBeenCalledWith({
      tenantId: "canonical-tenant",
      operationId: "durable-id",
    });
    expect(journal.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      executor.execute.mock.invocationCallOrder[0],
    );
    expect(journal.reserve).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
  it("revalidates the observed settled replay before returning a fresh receipt", async () => {
    admission.prepareInitialConfirmation.mockResolvedValue({
      kind: "replay",
      response: {
        private: "never serialize",
        job: { calendarEventId: "existing", updatedAt: now },
      },
    } as unknown as Preparation);
    expect(await service.book(input)).toEqual(receipt);
    expect(admission.readInitialConfirmationReceipt).toHaveBeenCalledWith(
      input,
      { calendarEventId: "existing", expectedUpdatedAt: now },
    );
    expect(journal.reserve).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });
  it.each([
    new BadRequestException("invalid"),
    new ConflictException("held"),
    new ServiceUnavailableException("disabled"),
  ])("preserves preflight refusal without writes: %p", async (error) => {
    admission.prepareInitialConfirmation.mockRejectedValue(error);
    await expect(service.book(input)).rejects.toBe(error);
    expect(journal.reserve).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });
  it("preserves a bounded reservation conflict without execution", async () => {
    const error = new ConflictException("changed");
    journal.reserve.mockRejectedValue(error);
    await expect(service.book(input)).rejects.toBe(error);
    expect(executor.execute).not.toHaveBeenCalled();
  });
  it("hides unknown reservation errors without retry or execution", async () => {
    journal.reserve.mockRejectedValue(new Error("private commit diagnostic"));
    await expect(service.book(input)).rejects.toThrow(
      "confirmation by the office",
    );
    expect(journal.reserve).toHaveBeenCalledTimes(1);
    expect(executor.execute).not.toHaveBeenCalled();
  });
  it.each([
    "finalized",
    "already_finalized",
    "pending",
    "needs_review",
    "unknown",
  ])(
    "maps internal executor result %s without exposing provider fields or retry",
    async (status) => {
      executor.execute.mockResolvedValue({
        status,
        privateProviderPayload: "never expose",
      });
      if (["finalized", "already_finalized"].includes(status)) {
        expect(await service.book(input)).toEqual(receipt);
        expect(admission.readInitialConfirmationReceipt).toHaveBeenCalledTimes(
          1,
        );
      } else {
        await expect(service.book(input)).rejects.toThrow(
          "confirmation by the office",
        );
        expect(admission.readInitialConfirmationReceipt).not.toHaveBeenCalled();
      }
      expect(executor.execute).toHaveBeenCalledTimes(1);
      expect(journal.reserve).toHaveBeenCalledTimes(1);
    },
  );
  it("hides execution failures without clearing, repeating or legacy fallback", async () => {
    executor.execute.mockRejectedValue(
      new Error("private provider/database failure"),
    );
    await expect(service.book(input)).rejects.toThrow(
      "confirmation by the office",
    );
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(journal.reserve).toHaveBeenCalledTimes(1);
  });
  it.each(["ready", "replay"])(
    "receipt failure after %s never returns stale confirmation",
    async (kind) => {
      if (kind === "replay")
        admission.prepareInitialConfirmation.mockResolvedValue({
          kind: "replay",
          response: {
            job: { calendarEventId: "existing", updatedAt: now },
            managementToken: "stale-token",
          },
        } as unknown as Preparation);
      admission.readInitialConfirmationReceipt.mockRejectedValue(
        new Error("private changed state"),
      );
      await expect(service.book(input)).rejects.toThrow(
        "confirmation by the office",
      );
      expect(journal.reserve).toHaveBeenCalledTimes(kind === "replay" ? 0 : 1);
      expect(executor.execute).toHaveBeenCalledTimes(kind === "replay" ? 0 : 1);
    },
  );
  it("keeps the composition and journal services absent from live module wiring", () => {
    const module = readFileSync(
      join(__dirname, "scheduling.module.ts"),
      "utf8",
    );
    for (const name of [
      "JournaledAppointmentBookingService",
      "CalendarOperationJournalService",
      "CalendarCreateExecutionService",
      "CalendarCreateReconciliationService",
    ])
      expect(module).not.toContain(name);
  });
});
