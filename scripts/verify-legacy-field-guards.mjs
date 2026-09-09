// Parent-owned disposable local PostgreSQL only. No external provider or real link.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  TechnicianWorkflowService,
} = require("../dist/jobs/technician-workflow.service.js");
const {
  JobLifecycleService,
} = require("../dist/jobs/job-lifecycle.service.js");

export async function verifyLegacyFieldGuards({
  prisma,
  jobData,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  let forbiddenCalls = 0,
    sequence = 0,
    fieldRefusals = 0;
  const forbidden = () => {
    forbiddenCalls++;
    throw new Error("Forbidden notification action");
  };
  const access = {
    tenantId: jobData.tenantId,
    technicianId: jobData.assignedUserId,
    expiresAt: new Date(Date.now() + 60000),
  };
  const links = { verify: () => access };
  const makeTech = (client) =>
    new TechnicianWorkflowService(
      client,
      links,
      { recordDeparture: forbidden, processOne: forbidden },
      { warn: forbidden },
    );
  const technician = makeTech(prisma),
    lifecycle = new JobLifecycleService(prisma);
  const input = (job, action = "accept") => ({
    rawToken: "synthetic",
    jobId: job.id,
    action,
    expectedUpdatedAt: job.updatedAt.toISOString(),
  });
  const completion = (job) => ({
    tenantId: job.tenantId,
    jobId: job.id,
    actorId: "fixture",
  });
  const create = async (overrides = {}) => {
    const start = new Date(Date.now() + (900 + sequence++) * 86400000);
    return prisma.job.create({
      data: {
        ...jobData,
        status: "ACCEPTED",
        technicianStatus: "ASSIGNED",
        calendarEventId: null,
        serviceWindowStart: start,
        serviceWindowEnd: new Date(start.getTime() + 3600000),
        ...overrides,
      },
    });
  };
  for (const calendarEventId of [null, "", " \t "]) {
    for (const shape of ["full", "start", "end"]) {
      let job = await create({
        calendarEventId,
        ...(shape === "start"
          ? { serviceWindowEnd: null }
          : shape === "end"
            ? { serviceWindowStart: null }
            : {}),
      });
      for (const technicianStatus of [
        "ASSIGNED",
        "ACCEPTED",
        "EN_ROUTE",
        "IN_PROGRESS",
        "COMPLETED",
      ]) {
        job = await prisma.job.update({
          where: { id: job.id },
          data: { technicianStatus },
        });
        const detail = await technician.get("synthetic", job.id);
        assert.equal(detail.calendarSyncPending, true);
        assert.deepEqual(detail.availableActions, []);
        assert.equal("calendarEventId" in detail, false);
        assert.equal("calendarOperations" in detail, false);
        const summary = Object.values(
          (await technician.list("synthetic")).groups,
        )
          .flat()
          .find((row) => row.jobId === job.id);
        assert.equal(summary.calendarSyncPending, true);
        assert.deepEqual(summary.availableActions, []);
        for (const action of [
          "accept",
          "on_my_way",
          "in_progress",
          "complete",
          "decline",
          "cannot_take",
        ]) {
          await assert.rejects(
            technician.update(input(job, action)),
            /Calendar synchronization is unfinished/,
          );
          fieldRefusals++;
        }
        assert.deepEqual(
          await prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
          job,
        );
      }
      await assert.rejects(
        lifecycle.completeJob(completion(job)),
        /Calendar synchronization is unfinished/,
      );
      await assert.rejects(
        lifecycle.completeJob({ ...completion(job), tenantId: otherTenantId }),
        /not found/,
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
      // Fixture-only ownership/deletion changes verify that the hold cannot bypass access.
      await prisma.job.update({
        where: { id: job.id },
        data: {
          assignedUserId: null,
          assignedUserTenantId: null,
        },
      });
      await assert.rejects(technician.get("synthetic", job.id), /not found/);
      await assert.rejects(technician.update(input(job)), /not found/);
      await prisma.job.update({
        where: { id: job.id },
        data: {
          assignedUserId: access.technicianId,
          assignedUserTenantId: access.tenantId,
          deletedAt: new Date(),
        },
      });
      await assert.rejects(technician.get("synthetic", job.id), /not found/);
      await assert.rejects(technician.update(input(job)), /not found/);
      await assert.rejects(lifecycle.completeJob(completion(job)), /not found/);
    }
  }
  assert.equal(fieldRefusals, 270);
  for (const method of ["technician", "lifecycle"]) {
    const job = await create({ calendarEventId: "fixture-confirmed" });
    let winner,
      writes = 0;
    const client = {
      user: prisma.user,
      $transaction: (callback) =>
        prisma.$transaction((tx) =>
          callback({
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
    };
    await assert.rejects(
      method === "technician"
        ? makeTech(client).update(input(job))
        : new JobLifecycleService(client).completeJob(completion(job)),
      /changed/,
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
  }
  assert.equal(forbiddenCalls, 0);
  return [
    "45 legacy field list/detail snapshots are provisional with zero available actions",
    "270 technician mutation/no-op refusals plus nine direct completion refusals preserve legacy reservations",
    "assignment ownership, tenant and deleted-job guards remain before held actions",
    "two competing unconfirmed reservations between read and CAS preserve winning fields despite identical timestamps",
    "no audit, journal, intent, message or provider action from held field/completion requests",
  ];
}
