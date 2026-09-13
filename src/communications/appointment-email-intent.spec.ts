import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  recordAppointmentEmailConfirmation,
  recordAppointmentEmailReschedule,
  recordAppointmentEmailCancellation,
} from "./appointment-email-intent";
describe("transaction-local initial confirmation email event", () => {
  const tenantId = "11111111-1111-4111-8111-111111111111",
    jobId = "22222222-2222-4222-8222-222222222222",
    sourceAuditId = "33333333-3333-4333-8333-333333333333";
  const input = { tenantId, jobId, sourceAuditId };
  const row = () => ({
    tenantId,
    jobId,
    customerId: "44444444-4444-4444-8444-444444444444",
    intakeSessionId: "synthetic-session",
    jobUpdatedAt: new Date("2030-01-01T00:00:00.001Z"),
    windowStart: new Date("2030-01-02T14:00:00Z"),
    windowEnd: new Date("2030-01-02T16:00:00Z"),
    calendarEventId: "PRIVATE-CALENDAR",
    source: "CALENDAR_ACK",
    calendarOperationId: null,
    tenantSettingsUpdatedAt: new Date("2030-01-01T00:00:00Z"),
    settingsValid: true,
    policyPresent: false,
    emailPolicy: null,
  });
  const db = {
    $queryRaw: jest.fn(),
    appointmentEmailIntent: { createMany: jest.fn(), findUnique: jest.fn() },
  };
  const tx = db as unknown as Prisma.TransactionClient;
  beforeEach(() => {
    jest.resetAllMocks();
    db.$queryRaw.mockResolvedValue([row()]);
    db.appointmentEmailIntent.createMany.mockResolvedValue({ count: 1 });
    db.appointmentEmailIntent.findUnique.mockResolvedValue({
      id: "intent",
      jobId,
    });
  });
  it("projects only immutable event fields and defaults blocked", async () => {
    await expect(
      recordAppointmentEmailConfirmation(tx, input),
    ).resolves.toEqual({ id: "intent" });
    expect(db.appointmentEmailIntent.createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: {
        kind: "APPOINTMENT_CONFIRMED",
        tenantId,
        jobId,
        customerId: row().customerId,
        intakeSessionId: row().intakeSessionId,
        jobUpdatedAt: row().jobUpdatedAt,
        windowStart: row().windowStart,
        windowEnd: row().windowEnd,
        source: "CALENDAR_ACK",
        calendarOperationId: null,
        tenantSettingsUpdatedAt: row().tenantSettingsUpdatedAt,
        sourceAuditId,
        calendarEventHash: createHash("sha256")
          .update("PRIVATE-CALENDAR")
          .digest("hex"),
        preference: "BLOCKED",
      },
    });
    expect(
      JSON.stringify(db.appointmentEmailIntent.createMany.mock.calls),
    ).not.toMatch(
      /PRIVATE-CALENDAR|emailPolicy|deliveryAvailable|managementUrl/,
    );
  });
  it("requires same transaction audit and exact job/tenant/version/journal joins", async () => {
    await recordAppointmentEmailConfirmation(tx, input);
    const sql = (db.$queryRaw.mock.calls as [Prisma.Sql][])[0][0];
    expect(sql.values).toEqual([sourceAuditId, jobId, tenantId]);
    for (const clause of [
      "a.xmin = pg_current_xact_id()::xid",
      "finalizedUpdatedAt",
      "appointment.initial_confirmed",
      "MATCHED_CREATE_READBACK",
      "op.status = 'FINALIZED'",
      'pending."finishedAt" IS NULL',
      'c."deletedAt" IS NULL',
      "t.status = 'ACTIVE'",
    ])
      expect(sql.sql).toContain(clause);
  });
  it.each(["tenantId", "jobId", "sourceAuditId"])(
    "validates %s before querying",
    async (key) => {
      await expect(
        recordAppointmentEmailConfirmation(tx, { ...input, [key]: "invalid" }),
      ).rejects.toThrow("bound finalization");
      expect(db.$queryRaw).not.toHaveBeenCalled();
    },
  );
  it.each([{ rows: [] }, { rows: [row(), row()] }])(
    "refuses missing or ambiguous finalization rows",
    async ({ rows }) => {
      db.$queryRaw.mockResolvedValue(rows);
      await expect(
        recordAppointmentEmailConfirmation(tx, input),
      ).rejects.toThrow("current finalized");
      expect(db.appointmentEmailIntent.createMany).not.toHaveBeenCalled();
    },
  );
  it.each([
    [{ settingsValid: false }, "INVALID"],
    [{ policyPresent: true, emailPolicy: null }, "INVALID"],
    [
      { policyPresent: true, emailPolicy: { version: 2, events: {} } },
      "INVALID",
    ],
    [
      {
        policyPresent: true,
        emailPolicy: {
          version: 1,
          events: {
            APPOINTMENT_CONFIRMED: false,
            APPOINTMENT_RESCHEDULED: true,
            APPOINTMENT_CANCELLED: true,
          },
        },
      },
      "BLOCKED",
    ],
    [
      {
        policyPresent: true,
        emailPolicy: {
          version: 1,
          events: {
            APPOINTMENT_CONFIRMED: true,
            APPOINTMENT_RESCHEDULED: false,
            APPOINTMENT_CANCELLED: false,
          },
        },
      },
      "PERMITTED",
    ],
  ])(
    "snapshots independent event-time preference %j",
    async (patch, preference) => {
      db.$queryRaw.mockResolvedValue([{ ...row(), ...patch }]);
      await recordAppointmentEmailConfirmation(tx, input);
      expect(db.appointmentEmailIntent.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ preference }),
        }),
      );
    },
  );
  it("retains matched CREATE identity without raw provider values", async () => {
    db.$queryRaw.mockResolvedValue([
      {
        ...row(),
        source: "CREATE_READBACK",
        calendarOperationId: sourceAuditId,
      },
    ]);
    await recordAppointmentEmailConfirmation(tx, input);
    expect(db.appointmentEmailIntent.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: "CREATE_READBACK",
          calendarOperationId: sourceAuditId,
        }),
      }),
    );
  });
  it("deduplicates without updating prior snapshots", async () => {
    db.appointmentEmailIntent.createMany.mockResolvedValue({ count: 0 });
    await expect(
      recordAppointmentEmailConfirmation(tx, input),
    ).resolves.toEqual({ id: "intent" });
  });
  it.each([null, { id: "intent", jobId: "other" }])(
    "refuses a conflicting event identity",
    async (saved) => {
      db.appointmentEmailIntent.findUnique.mockResolvedValue(saved);
      await expect(
        recordAppointmentEmailConfirmation(tx, input),
      ).rejects.toThrow("identity conflicts");
    },
  );
  it("propagates persistence failure to abort caller transaction", async () => {
    db.appointmentEmailIntent.createMany.mockRejectedValue(
      Error("synthetic-storage-failure"),
    );
    await expect(recordAppointmentEmailConfirmation(tx, input)).rejects.toThrow(
      "synthetic-storage-failure",
    );
    expect(db.appointmentEmailIntent.findUnique).not.toHaveBeenCalled();
  });
  describe.each([
    ["APPOINTMENT_RESCHEDULED", recordAppointmentEmailReschedule],
    ["APPOINTMENT_CANCELLED", recordAppointmentEmailCancellation],
  ] as const)("%s", (kind, recorder) => {
    it.each([false, true])(
      "captures only its own preference (%s)",
      async (permitted) => {
        db.$queryRaw.mockResolvedValue([
          {
            ...row(),
            calendarEventHash: "a".repeat(64),
            policyPresent: true,
            emailPolicy: {
              version: 1,
              events: {
                APPOINTMENT_CONFIRMED: !permitted,
                APPOINTMENT_RESCHEDULED: !permitted,
                APPOINTMENT_CANCELLED: !permitted,
                [kind]: permitted,
              },
            },
          },
        ]);
        await recorder(tx, input);
        expect(db.appointmentEmailIntent.createMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              kind,
              preference: permitted ? "PERMITTED" : "BLOCKED",
              calendarEventHash:
                kind === "APPOINTMENT_CANCELLED"
                  ? "a".repeat(64)
                  : createHash("sha256")
                      .update(row().calendarEventId)
                      .digest("hex"),
            }),
          }),
        );
        const sql = (db.$queryRaw.mock.calls as [Prisma.Sql][])[0][0];
        for (const clause of [
          "a.xmin = pg_current_xact_id()::xid",
          '"AppointmentCancellationSnapshot"',
          "claimedUpdatedAt",
          "finalizedUpdatedAt",
          'snap."intakeSessionId" IS NOT DISTINCT FROM j."intakeSessionId"',
          'j."updatedAt" > snap."claimedUpdatedAt"',
        ])
          expect(sql.sql).toContain(clause);
        expect(sql.values).toContain(kind);
        expect(sql.values).toContain(
          kind === "APPOINTMENT_CANCELLED"
            ? "appointment.customer_cancelled"
            : "appointment.customer_rescheduled",
        );
      },
    );
    it("refuses unbound or historical receipts without persistence", async () => {
      db.$queryRaw.mockResolvedValue([]);
      await expect(recorder(tx, input)).rejects.toThrow("current finalized");
      expect(db.appointmentEmailIntent.createMany).not.toHaveBeenCalled();
    });
  });
});
