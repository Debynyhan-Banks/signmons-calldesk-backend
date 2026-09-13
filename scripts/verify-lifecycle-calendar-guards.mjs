// Parent-owned disposable local database only. No Calendar or delivery transport.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  CalendarOperationJournalService,
} = require("../dist/scheduling/calendar-operation-journal.service.js");
const {
  JobLifecycleService,
} = require("../dist/jobs/job-lifecycle.service.js");
const {
  TechnicianWorkflowService,
} = require("../dist/jobs/technician-workflow.service.js");

export async function verifyLifecycleCalendarGuards({
  prisma,
  jobData,
  otherTenantId,
  disabled,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const ids = [];
  const journal = new CalendarOperationJournalService(prisma),
    lifecycle = new JobLifecycleService(prisma);
  const access = {
    tenantId: jobData.tenantId,
    technicianId: jobData.assignedUserId,
    expiresAt: new Date(Date.now() + 60000),
  };
  const links = { verify: () => access };
  const forbidden = () => {
    throw new Error("No notification action is permitted while held");
  };
  const technician = new TechnicianWorkflowService(
    prisma,
    links,
    { recordDeparture: forbidden, processOne: forbidden },
    { warn: forbidden },
  );
  const request = (job) => ({
    tenantId: job.tenantId,
    jobId: job.id,
    actorId: "fixture",
  });
  const update = (job, action = "accept") => ({
    rawToken: "synthetic",
    jobId: job.id,
    action,
    expectedUpdatedAt: job.updatedAt.toISOString(),
  });
  const create = async (action = "RESCHEDULE") => {
    const start = new Date(Date.now() + (ids.length + 300) * 86400000),
      end = new Date(start.getTime() + 3600000);
    const job = await prisma.job.create({
      data: {
        ...jobData,
        status: action === "CREATE" ? "CREATED" : "ACCEPTED",
        technicianStatus: "ASSIGNED",
        intakeSessionId: randomUUID(),
        calendarEventId: action === "CREATE" ? null : randomUUID(),
        serviceWindowStart: action === "CREATE" ? null : start,
        serviceWindowEnd: action === "CREATE" ? null : end,
      },
    });
    ids.push(job.id);
    return {
      job,
      input: {
        tenantId: job.tenantId,
        jobId: job.id,
        expectedUpdatedAt: job.updatedAt,
        action,
        calendarId: "fixture@example.invalid",
        timeZone: "UTC",
        start: new Date(end.getTime() + 3600000),
        end: new Date(end.getTime() + 7200000),
        label: "Synthetic pending window",
      },
    };
  };
  try {
    for (const action of ["CREATE", "RESCHEDULE", "CANCEL"]) {
      const fixture = await create(action),
        operation = await journal.reserve(fixture.input);
      for (const status of [
        "PENDING",
        "UNCERTAIN",
        "APPLIED",
        "NEEDS_REVIEW",
      ]) {
        await prisma.calendarOperation.update({
          where: { id: operation.id },
          data: { status },
        });
        const job = await prisma.job.findUniqueOrThrow({
          where: { id: fixture.job.id },
        });
        const auditCount = await prisma.auditLog.count({
          where: { entityId: job.id },
        });
        await assert.rejects(
          lifecycle.completeJob(request(job)),
          /Calendar synchronization is unfinished/,
        );
        for (const fieldAction of [
          "accept",
          "on_my_way",
          "in_progress",
          "complete",
          "decline",
          "cannot_take",
        ])
          await assert.rejects(
            technician.update(update(job, fieldAction)),
            /Calendar synchronization is unfinished/,
          );
        assert.deepEqual(
          await prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
          job,
        );
        assert.equal(
          await prisma.auditLog.count({ where: { entityId: job.id } }),
          auditCount,
        );
        assert.equal(
          await prisma.smsEnqueueIntent.count({ where: { jobId: job.id } }),
          0,
        );
        const detail = await technician.get("synthetic", job.id);
        assert.equal(detail.calendarSyncPending, true);
        assert.deepEqual(detail.availableActions, []);
        assert.equal(JSON.stringify(detail).includes(operation.id), false);
        const list = await technician.list("synthetic");
        assert.ok(
          Object.values(list.groups)
            .flat()
            .some(
              (row) =>
                row.jobId === job.id &&
                row.calendarSyncPending &&
                row.availableActions.length === 0,
            ),
        );
        await assert.rejects(
          lifecycle.completeJob({ ...request(job), tenantId: otherTenantId }),
          /not found/,
        );
        const otherLink = new TechnicianWorkflowService(
          prisma,
          { verify: () => ({ ...access, technicianId: randomUUID() }) },
          {},
          {},
        );
        await assert.rejects(
          otherLink.update(update(job)),
          /access is no longer active/,
        );
      }
      // Terminal history removes only the journal hold, not an unconfirmed CREATE.
      await prisma.calendarOperation.update({
        where: { id: operation.id },
        data: { status: "ABORTED", finishedAt: new Date() },
      });
      const job = await prisma.job.findUniqueOrThrow({
        where: { id: fixture.job.id },
      });
      if (action === "CREATE") {
        await assert.rejects(
          technician.update(update(job)),
          /Calendar synchronization is unfinished/,
        );
        await assert.rejects(
          lifecycle.completeJob(request(job)),
          /Calendar synchronization is unfinished/,
        );
        assert.deepEqual(
          await prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
          job,
        );
      } else if (action === "CANCEL")
        await assert.rejects(technician.update(update(job)), /Cancelled jobs/);
      else {
        const accepted = await technician.update(update(job));
        assert.equal(accepted.changed, true);
        assert.ok(new Date(accepted.updatedAt) > job.updatedAt);
        assert.equal((await lifecycle.completeJob(request(job))).changed, true);
        assert.equal(
          (await lifecycle.completeJob(request(job))).changed,
          false,
        );
      }
    }

    // Deterministic interleaving: reserve AFTER the mutation reads, before its CAS.
    for (const consumer of ["lifecycle", "technician"]) {
      const fixture = await create();
      let injected = false;
      const wrapped = {
        ...prisma,
        user: prisma.user,
        $transaction: (fn) =>
          prisma.$transaction((tx) =>
            fn({
              ...tx,
              job: {
                ...tx.job,
                findFirst: async (args) => {
                  const job = await tx.job.findFirst(args);
                  if (!injected) {
                    injected = true;
                    await journal.reserve(fixture.input);
                  }
                  return job;
                },
              },
            }),
          ),
      };
      const service =
        consumer === "lifecycle"
          ? new JobLifecycleService(wrapped)
          : new TechnicianWorkflowService(wrapped, links, {}, {});
      await assert.rejects(
        consumer === "lifecycle"
          ? service.completeJob(request(fixture.job))
          : service.update(update(fixture.job)),
        /changed/,
      );
      assert.equal(
        await prisma.auditLog.count({ where: { entityId: fixture.job.id } }),
        0,
      );
      assert.equal(
        (
          await prisma.calendarOperation.findFirstOrThrow({
            where: { jobId: fixture.job.id },
          })
        ).status,
        "PENDING",
      );
    }
    // Opposite order: a committed mutation invalidates the old journal reservation.
    for (const consumer of ["lifecycle", "technician"]) {
      const fixture = await create();
      if (consumer === "lifecycle")
        await lifecycle.completeJob(request(fixture.job));
      else await technician.update(update(fixture.job));
      await assert.rejects(
        journal.reserve(fixture.input),
        /changed or has unfinished/,
      );
      assert.equal(
        await prisma.calendarOperation.count({
          where: { jobId: fixture.job.id },
        }),
        0,
      );
    }
    // Real audit failure must roll back both completion and its version advance.
    const rollback = await create();
    const failing = {
      $transaction: (fn) =>
        prisma.$transaction((tx) =>
          fn({
            ...tx,
            auditLog: {
              create: async () => {
                throw new Error("synthetic audit failure");
              },
            },
          }),
        ),
    };
    await assert.rejects(
      new JobLifecycleService(failing).completeJob(request(rollback.job)),
      /audit failure/,
    );
    assert.deepEqual(
      await prisma.job.findUniqueOrThrow({ where: { id: rollback.job.id } }),
      rollback.job,
    );
    // Existing departure intent capture still works once no journal is unfinished.
    const departure = await create();
    const normal = new TechnicianWorkflowService(prisma, links, disabled, {
      warn: forbidden,
    });
    await normal.update(update(departure.job));
    const accepted = await prisma.job.findUniqueOrThrow({
      where: { id: departure.job.id },
    });
    await normal.update(update(accepted, "on_my_way"));
    assert.equal(
      await prisma.smsEnqueueIntent.count({
        where: { jobId: departure.job.id },
      }),
      1,
    );
    return [
      "12 journal action/status combinations block completion and all six technician mutations",
      "held cancellation remains visible with no field actions",
      "tenant and active-technician boundaries preserved",
      "deterministic reservation-between-read-and-CAS blocks both mutation paths",
      "committed mutations invalidate stale journal reservations",
      "completion audit failure rolls back version and state",
      "terminal journal retains unconfirmed CREATE hold; ordinary settled completion/replay and departure intent capture preserved",
    ];
  } finally {
    await prisma.calendarOperation.deleteMany({
      where: { tenantId: jobData.tenantId, jobId: { in: ids } },
    });
  }
}
