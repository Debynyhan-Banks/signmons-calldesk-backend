import {
  calendarOperationPending,
  requireCalendarOperationSettled,
} from "./calendar-operation-guard";
import {
  evaluateTransactionalMessageState,
  transactionalMessageStateHash,
  type TransactionalMessageJob,
} from "../communications/transactional-message-state";
import { TransactionalMessageTemplateKey } from "../communications/transactional-message-template.service";

describe("unfinished Calendar consumer policy", () => {
  it("fails closed when the relation was not selected", () => {
    expect(calendarOperationPending({} as never)).toBe(true);
    expect(() => requireCalendarOperationSettled({} as never)).toThrow(
      "on hold",
    );
  });
  it("accepts an explicitly empty unfinished selection", () => {
    expect(calendarOperationPending({ calendarOperations: [] })).toBe(false);
  });
  it.each(Object.values(TransactionalMessageTemplateKey))(
    "holds %s before judging a transient local state",
    (template) => {
      const job = {
        id: "job",
        status: "CANCELLED",
        deletedAt: null,
        calendarOperations: [{ id: "unfinished" }],
        calendarEventId: null,
        serviceWindowStart: null,
        serviceWindowEnd: null,
        tenant: { name: "Fixture", timezone: "UTC" },
        customer: { phone: "+15555550123" },
      } as TransactionalMessageJob;
      expect(evaluateTransactionalMessageState(template, job)).toBe(
        "CALENDAR_PENDING",
      );
      expect(transactionalMessageStateHash(template, job)).toBe(
        transactionalMessageStateHash(template, {
          ...job,
          calendarOperations: [],
        }),
      );
      expect(
        evaluateTransactionalMessageState(template, {
          ...job,
          deletedAt: new Date(),
        }),
      ).toBe("MISSING");
    },
  );
});
