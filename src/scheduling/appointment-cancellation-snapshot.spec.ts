import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { captureCancellationSnapshot } from "./appointment-cancellation-snapshot";

describe("pre-clear cancellation snapshot", () => {
  const job = { id: "job", tenantId: "tenant", updatedAt: new Date(10) };
  const version = new Date(11);
  const row = {
    customerId: "customer",
    intakeSessionId: "session",
    windowStart: new Date(20),
    windowEnd: new Date(30),
    calendarEventId: "PRIVATE-CALENDAR",
  };
  function setup() {
    return {
      $queryRaw: jest.fn().mockResolvedValue([row]),
      appointmentCancellationSnapshot: { create: jest.fn() },
    };
  }
  it("projects canonical pre-clear state, never caller-provided window or raw provider id", async () => {
    const db = setup();
    await captureCancellationSnapshot(
      db as never,
      { ...job, serviceWindowStart: new Date(999) } as never,
      version,
    );
    expect(db.appointmentCancellationSnapshot.create).toHaveBeenCalledWith({
      data: {
        tenantId: job.tenantId,
        jobId: job.id,
        claimedUpdatedAt: version,
        previousUpdatedAt: job.updatedAt,
        customerId: row.customerId,
        intakeSessionId: row.intakeSessionId,
        windowStart: row.windowStart,
        windowEnd: row.windowEnd,
        calendarEventHash: createHash("sha256")
          .update(row.calendarEventId)
          .digest("hex"),
      },
    });
    const sql = (db.$queryRaw.mock.calls as [Prisma.Sql][])[0][0];
    expect(sql.values).toEqual([job.id, job.tenantId, job.updatedAt]);
    for (const clause of [
      "t.status = 'ACTIVE'",
      "j.status = 'ACCEPTED'",
      'c."deletedAt" IS NULL',
      'op."finishedAt" IS NULL',
    ])
      expect(sql.sql).toContain(clause);
    expect(
      JSON.stringify(db.appointmentCancellationSnapshot.create.mock.calls),
    ).not.toContain("PRIVATE-CALENDAR");
  });
  it.each([{ rows: [] }, { rows: [row, row] }])(
    "rejects absent/ambiguous canonical rows",
    async ({ rows }) => {
      const db = setup();
      db.$queryRaw.mockResolvedValue(rows);
      await expect(
        captureCancellationSnapshot(db as never, job as never, version),
      ).rejects.toThrow("changed");
      expect(db.appointmentCancellationSnapshot.create).not.toHaveBeenCalled();
    },
  );
  it("refuses version reuse", async () => {
    const db = setup();
    await expect(
      captureCancellationSnapshot(db as never, job as never, job.updatedAt),
    ).rejects.toThrow("changed");
    expect(db.appointmentCancellationSnapshot.create).not.toHaveBeenCalled();
  });
  it("propagates failure so the claim transaction cannot clear the window", async () => {
    const db = setup();
    db.appointmentCancellationSnapshot.create.mockRejectedValue(
      Error("storage failed"),
    );
    await expect(
      captureCancellationSnapshot(db as never, job as never, version),
    ).rejects.toThrow("storage failed");
  });
});
