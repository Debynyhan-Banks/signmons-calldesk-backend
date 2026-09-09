// Runs only in the parent's random local PostgreSQL fixture; no provider clients.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  DispatchBoardService,
} = require("../dist/jobs/dispatch-board.service.js");

export async function verifyLegacyDispatchGuards({
  prisma,
  jobData,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const service = new DispatchBoardService(prisma);
  const input = (job) => ({
    tenantId: job.tenantId,
    jobId: job.id,
    technicianId: jobData.assignedUserId,
    expectedUpdatedAt: job.updatedAt.toISOString(),
    actorId: "fixture",
    reason: "Synthetic approved override must not bypass hold",
  });
  let fixtures = 0,
    refusals = 0;
  const create = async (overrides = {}) => {
    const start = new Date(Date.now() + (600 + fixtures++) * 86400000);
    return prisma.job.create({
      data: {
        ...jobData,
        status: "ACCEPTED",
        calendarEventId: null,
        serviceWindowStart: start,
        serviceWindowEnd: new Date(start.getTime() + 3600000),
        ...overrides,
      },
    });
  };
  for (const calendarEventId of [null, "", " \t "]) {
    for (const shape of ["full", "start", "end"]) {
      for (const assigned of [false, true]) {
        const job = await create({
          calendarEventId,
          ...(shape === "start"
            ? { serviceWindowEnd: null }
            : shape === "end"
              ? { serviceWindowStart: null }
              : {}),
          assignedUserId: assigned ? jobData.assignedUserId : null,
          assignedUserTenantId: assigned ? jobData.tenantId : null,
        });
        const detail = await service.get(job.tenantId, job.id);
        assert.equal(detail.calendarSyncPending, true);
        assert.equal(detail.queue, "ESCALATED");
        assert.equal(detail.recommendation, null);
        assert.ok(detail.candidates.length > 0);
        assert.ok(
          detail.candidates.every(
            (c) =>
              !c.eligible && c.reasonCodes.includes("CALENDAR_SYNC_PENDING"),
          ),
        );
        assert.equal("calendarEventId" in detail, false);
        assert.equal("calendarOperations" in detail, false);
        const summary = (await service.list(job.tenantId)).find(
          (row) => row.jobId === job.id,
        );
        assert.equal(summary.calendarSyncPending, true);
        assert.equal(summary.queue, "ESCALATED");
        for (const action of [
          () => service.assign(input(job)),
          () =>
            service.assign({
              ...input(job),
              technicianId: "00000000-0000-4000-8000-000000000000",
            }),
          () => service.cancelAssignment(input(job)),
        ]) {
          await assert.rejects(
            action,
            /Calendar synchronization is unfinished/,
          );
          refusals++;
        }
        await assert.rejects(service.get(otherTenantId, job.id), /not found/);
        for (const method of ["assign", "cancelAssignment"])
          await assert.rejects(
            service[method]({ ...input(job), tenantId: otherTenantId }),
            /not found/,
          );
        assert.equal(
          (await service.list(otherTenantId)).some(
            (row) => row.jobId === job.id,
          ),
          false,
        );
        assert.deepEqual(
          await prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
          job,
        );
        for (const table of [
          "smsEnqueueIntent",
          "communicationEvent",
          "calendarOperation",
        ])
          assert.equal(
            await prisma[table].count({
              where: { tenantId: job.tenantId, jobId: job.id },
            }),
            0,
          );
        assert.equal(
          await prisma.auditLog.count({
            where: { tenantId: job.tenantId, entityId: job.id },
          }),
          0,
        );
        await prisma.job.update({
          where: { id: job.id },
          data: { deletedAt: new Date() },
        });
        await assert.rejects(service.get(job.tenantId, job.id), /not found/);
        for (const method of ["assign", "cancelAssignment"])
          await assert.rejects(service[method](input(job)), /not found/);
      }
    }
  }
  assert.equal(refusals, 54);
  // Simulate a competing writer after dispatch's read, preserving the timestamp
  // intentionally. Exact reservation fields must still reject the stale write.
  for (const method of ["assign", "cancelAssignment"]) {
    const job = await create({
      calendarEventId: "fixture-confirmed",
      assignedUserId: method === "assign" ? null : jobData.assignedUserId,
      assignedUserTenantId: method === "assign" ? null : jobData.tenantId,
    });
    let winner,
      writes = 0;
    const racing = new DispatchBoardService({
      $transaction: (callback) =>
        prisma.$transaction((tx) =>
          callback({
            user: tx.user,
            auditLog: tx.auditLog,
            job: {
              findFirst: tx.job.findFirst.bind(tx.job),
              updateMany: async (args) => {
                writes++;
                winner = await prisma.job.update({
                  where: { id: job.id },
                  data: {
                    calendarEventId: null,
                    updatedAt: job.updatedAt,
                  },
                });
                return tx.job.updateMany(args);
              },
            },
          }),
        ),
    });
    await assert.rejects(
      racing[method](input(job)),
      /changed after it was loaded/,
    );
    assert.equal(writes, 1);
    assert.deepEqual(
      await prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
      winner,
    );
    assert.equal(
      await prisma.auditLog.count({
        where: { tenantId: job.tenantId, entityId: job.id },
      }),
      0,
    );
    assert.equal(
      (await service.get(job.tenantId, job.id)).calendarSyncPending,
      true,
    );
  }
  return [
    "18 legacy dispatch snapshots expose provisional ESCALATED state with no eligible recommendation",
    "54 assignment/reassignment/cancellation including no-op refusals; tenant/deleted boundaries preserved",
    "two actual competing writes between read and CAS retain the new reservation even with unchanged timestamp",
    "held dispatch jobs and audits unchanged; no journal/intent/message or provider action",
  ];
}
