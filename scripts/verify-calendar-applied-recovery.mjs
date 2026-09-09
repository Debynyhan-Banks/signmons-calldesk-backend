// Parent-owned disposable database. No real Calendar adapter or message sender.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  CalendarAppliedRecoveryService,
} = require("../dist/scheduling/calendar-applied-recovery.service.js");
const {
  CalendarCreateReconciliationService,
} = require("../dist/scheduling/calendar-create-reconciliation.service.js");
const {
  CalendarOperationJournalService,
} = require("../dist/scheduling/calendar-operation-journal.service.js");
const {
  CalendarCreateExecutionService,
} = require("../dist/scheduling/calendar-create-execution.service.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");

export async function verifyCalendarAppliedRecovery({
  prisma,
  intents,
  jobData,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const ids = [];
  let reads = 0;
  const asActor = (fn, role = "owner", tenantId = jobData.tenantId) =>
    new Promise((resolve, reject) => {
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({
          userId: "synthetic-recovery-reviewer",
          tenantId,
          role,
        });
        Promise.resolve().then(fn).then(resolve, reject);
      });
    });
  const event = (op) => ({
    outcome: "found",
    event: {
      id: op.calendarEventId,
      status: "confirmed",
      blockingSingleEvent: true,
      etag: "private-synthetic-etag",
      tenantId: op.tenantId,
      jobId: op.jobId,
      operationId: op.id,
      start: op.desiredWindowStart.toISOString(),
      end: op.desiredWindowEnd.toISOString(),
    },
  });
  const reader = {
    read: async (calendarId, calendarEventId) => {
      reads++;
      return event(
        await prisma.calendarOperation.findFirstOrThrow({
          where: { calendarId, calendarEventId },
        }),
      );
    },
  };
  const reconciler = new CalendarCreateReconciliationService(
    prisma,
    reader,
    intents,
  );
  const recovery = new CalendarAppliedRecoveryService(prisma, reconciler);
  const make = async () => {
    const job = await prisma.job.create({
      data: {
        ...jobData,
        intakeSessionId: randomUUID(),
        status: "CREATED",
        calendarEventId: null,
        serviceWindowStart: null,
        serviceWindowEnd: null,
        preferredTimeText: null,
        assignedUserId: null,
        assignedUserTenantId: null,
        technicianStatus: null,
      },
    });
    ids.push(job.id);
    const start = new Date(Date.UTC(2041, 0, ids.length, 12));
    const op = await new CalendarOperationJournalService(prisma).reserve({
      tenantId: job.tenantId,
      jobId: job.id,
      expectedUpdatedAt: job.updatedAt,
      action: "CREATE",
      calendarId: "private-recovery@example.invalid",
      timeZone: "UTC",
      start,
      end: new Date(start.getTime() + 3600000),
      label: "Private fictional arrival",
    });
    await new CalendarCreateExecutionService(
      prisma,
      { create: async () => {} },
      { reconcile: async () => ({ status: "pending" }) },
    ).execute({ tenantId: job.tenantId, operationId: op.id });
    const operation = await prisma.calendarOperation.findUniqueOrThrow({
      where: { id: op.id },
    });
    assert.equal(operation.status, "APPLIED");
    return {
      job,
      operation,
      input: {
        operationId: op.id,
        expectedUpdatedAt: operation.updatedAt.toISOString(),
        acknowledgeReadback: true,
      },
    };
  };
  const snapshot = async (f) => ({
    job: await prisma.job.findUniqueOrThrow({ where: { id: f.job.id } }),
    operation: await prisma.calendarOperation.findUniqueOrThrow({
      where: { id: f.operation.id },
    }),
    audits: await prisma.auditLog.findMany({
      where: { entityId: { in: [f.job.id, f.operation.id] } },
      orderBy: { id: "asc" },
    }),
    intents: await prisma.smsEnqueueIntent.findMany({
      where: { jobId: f.job.id },
    }),
  });
  const requestAudits = (snapshot) =>
    snapshot.audits.filter(
      (a) => a.action === "appointment.applied_create_readback_requested",
    );
  const messagesBefore = await prisma.communicationEvent.count();
  try {
    const refused = await make(),
      original = await snapshot(refused);
    await assert.rejects(
      recovery.recover(refused.input),
      (e) => e.getStatus() === 401,
    );
    for (const role of ["dispatcher", "tech", "read_only", null])
      await assert.rejects(
        asActor(() => recovery.recover(refused.input), role),
        (e) => e.getStatus() === 403,
      );
    await assert.rejects(
      asActor(() => recovery.recover(refused.input), "owner", otherTenantId),
      (e) => e.getStatus() === 404,
    );
    await assert.rejects(
      asActor(() =>
        recovery.recover({ ...refused.input, acknowledgeReadback: false }),
      ),
      (e) => e.getStatus() === 400,
    );
    await assert.rejects(
      asActor(() =>
        recovery.recover({
          ...refused.input,
          expectedUpdatedAt: new Date(0).toISOString(),
        }),
      ),
      (e) => e.getStatus() === 409,
    );
    assert.deepEqual(await snapshot(refused), original);
    assert.equal(reads, 0);
    for (const status of [
      "PENDING",
      "UNCERTAIN",
      "NEEDS_REVIEW",
      "FINALIZED",
      "ABORTED",
    ]) {
      const f = await make();
      const op = await prisma.calendarOperation.update({
        where: { id: f.operation.id },
        data: {
          status,
          finishedAt: ["FINALIZED", "ABORTED"].includes(status)
            ? new Date()
            : null,
        },
      });
      const before = await snapshot(f);
      await assert.rejects(
        asActor(() =>
          recovery.recover({
            ...f.input,
            expectedUpdatedAt: op.updatedAt.toISOString(),
          }),
        ),
        (e) => e.getStatus() === 409,
      );
      assert.deepEqual(await snapshot(f), before);
    }
    assert.equal(reads, 0);
    for (const role of ["owner", "admin"]) {
      const f = await make();
      assert.deepEqual(await asActor(() => recovery.recover(f.input), role), {
        status: "finalized",
      });
      const done = await snapshot(f),
        [audit] = requestAudits(done);
      assert.equal(done.operation.status, "FINALIZED");
      assert.equal(done.job.calendarEventId, f.operation.calendarEventId);
      assert.equal(done.intents.length, 1);
      assert.equal(done.audits.length, 2);
      assert.equal(audit.actorId, "synthetic-recovery-reviewer");
      assert.deepEqual(
        Object.keys(audit.metadata).sort(),
        [
          "jobId",
          "reasonCode",
          "acknowledged",
          "reviewedUpdatedAt",
          "admittedUpdatedAt",
        ].sort(),
      );
      assert.equal(audit.metadata.reviewedUpdatedAt, f.input.expectedUpdatedAt);
      const readsBefore = reads;
      await assert.rejects(
        asActor(() => recovery.recover(f.input)),
        (e) => e.getStatus() === 409,
      );
      assert.deepEqual(await snapshot(f), done);
      assert.equal(reads, readsBefore);
    }
    const concurrent = await make(),
      beforeConcurrentReads = reads;
    const results = await Promise.allSettled([
      asActor(() => recovery.recover(concurrent.input)),
      asActor(() => recovery.recover(concurrent.input)),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const concurrentDone = await snapshot(concurrent);
    assert.equal(requestAudits(concurrentDone).length, 1);
    assert.equal(concurrentDone.intents.length, 1);
    assert.equal(reads, beforeConcurrentReads + 1);

    const rollback = await make(),
      beforeRollback = await snapshot(rollback),
      beforeRollbackReads = reads;
    const failedAudit = new CalendarAppliedRecoveryService(
      {
        $transaction: (fn) =>
          prisma.$transaction((tx) =>
            fn({
              ...tx,
              auditLog: {
                ...tx.auditLog,
                create: async (args) => {
                  await tx.auditLog.create(args);
                  throw new Error("synthetic audit failure");
                },
              },
            }),
          ),
      },
      reconciler,
    );
    await assert.rejects(
      asActor(() => failedAudit.recover(rollback.input)),
      (e) => e.getStatus() === 503,
    );
    assert.deepEqual(await snapshot(rollback), beforeRollback);
    assert.equal(reads, beforeRollbackReads);

    const lostAck = await make(),
      beforeAdmission = await snapshot(lostAck),
      beforeAckReads = reads;
    const unknownAdmission = new CalendarAppliedRecoveryService(
      {
        $transaction: async (fn) => {
          await prisma.$transaction(fn);
          throw new Error("synthetic lost commit acknowledgment");
        },
      },
      reconciler,
    );
    await assert.rejects(
      asActor(() => unknownAdmission.recover(lostAck.input)),
      (e) => e.getStatus() === 503,
    );
    const admitted = await snapshot(lostAck);
    assert.equal(admitted.operation.status, "APPLIED");
    assert.equal(requestAudits(admitted).length, 1);
    assert.equal(admitted.intents.length, 0);
    assert.equal(reads, beforeAckReads);
    assert.deepEqual(admitted.job, beforeAdmission.job);
    assert.deepEqual(
      { ...admitted.operation, updatedAt: lostAck.operation.updatedAt },
      lostAck.operation,
    );
    await assert.rejects(
      asActor(() => recovery.recover(lostAck.input)),
      (e) => e.getStatus() === 409,
    );
    // Fresh service/context + explicit new review, never automatic restart/retry.
    assert.deepEqual(
      await asActor(() =>
        new CalendarAppliedRecoveryService(prisma, reconciler).recover({
          ...lostAck.input,
          expectedUpdatedAt: admitted.operation.updatedAt.toISOString(),
        }),
      ),
      { status: "finalized" },
    );
    assert.equal(requestAudits(await snapshot(lostAck)).length, 2);
    assert.equal((await snapshot(lostAck)).intents.length, 1);

    const overtaken = await make(),
      beforeOvertakenReads = reads;
    let winner;
    const changedAfterAdmission = new CalendarAppliedRecoveryService(prisma, {
      reconcile: async (args) => {
        await prisma.calendarOperation.update({
          where: { id: overtaken.operation.id },
          data: {
            status: "NEEDS_REVIEW",
            updatedAt: new Date(args.expectedUpdatedAt.getTime() + 1),
          },
        });
        winner = await snapshot(overtaken);
        return reconciler.reconcile(args);
      },
    });
    await assert.rejects(
      asActor(() => changedAfterAdmission.recover(overtaken.input)),
      (e) => e.getStatus() === 503,
    );
    assert.deepEqual(await snapshot(overtaken), winner);
    assert.equal(reads, beforeOvertakenReads);

    // A different explicitly refreshed review can supersede an in-flight read;
    // admission is version ownership, not a global provider-read lease.
    const superseded = await make();
    let secondResult;
    const lateReader = new CalendarCreateReconciliationService(
      prisma,
      {
        read: async () => {
          const latest = await snapshot(superseded);
          secondResult = await asActor(() =>
            recovery.recover({
              ...superseded.input,
              expectedUpdatedAt: latest.operation.updatedAt.toISOString(),
            }),
          );
          return event(superseded.operation);
        },
      },
      intents,
    );
    assert.deepEqual(
      await asActor(() =>
        new CalendarAppliedRecoveryService(prisma, lateReader).recover(
          superseded.input,
        ),
      ),
      { status: "already_finalized" },
    );
    assert.deepEqual(secondResult, { status: "finalized" });
    const supersededDone = await snapshot(superseded);
    assert.equal(requestAudits(supersededDone).length, 2);
    assert.equal(supersededDone.audits.length, 3);
    assert.equal(supersededDone.intents.length, 1);
    assert.equal(supersededDone.operation.status, "FINALIZED");

    for (const outcome of ["unavailable", "unverified"]) {
      const f = await make();
      const localReconciler = new CalendarCreateReconciliationService(
        prisma,
        { read: async () => ({ outcome }) },
        intents,
      );
      const result = await asActor(() =>
        new CalendarAppliedRecoveryService(prisma, localReconciler).recover(
          f.input,
        ),
      );
      assert.equal(
        result.status,
        outcome === "unavailable" ? "pending" : "needs_review",
      );
      const held = await snapshot(f);
      assert.equal(
        held.operation.status,
        outcome === "unavailable" ? "UNCERTAIN" : "NEEDS_REVIEW",
      );
      assert.equal(held.intents.length, 0);
      assert.equal(requestAudits(held).length, 1);
      assert.equal(held.job.calendarEventId, null);
    }
    assert.equal(await prisma.communicationEvent.count(), messagesBefore);
    return [
      "reviewed APPLIED recovery enforces context/role/tenant/ack/version; every other status refuses without reads or writes",
      "owner/admin matching synthetic read-back finalizes one job/journal/intent with request and confirmation audits",
      "two same-version requests yield one admission audit/read/finalization; stale repeat refuses",
      "actual audit failure rolls back admission; lost admission acknowledgment leaves one audit/version and performs zero reads",
      "fresh explicit review after lost acknowledgment recovers once, with separate request audit and no duplicate intent",
      "newer committed hold after admission rejects reconciler version before provider read and preserves winner",
      "a fresh explicit review can supersede an in-flight read; two request audits but only one finalization/intent",
      "unavailable/unverified read-back remains UNCERTAIN/NEEDS_REVIEW; no insert, clear, message send or automatic retry",
    ];
  } finally {
    await prisma.calendarOperation.deleteMany({
      where: { tenantId: jobData.tenantId, jobId: { in: ids } },
    });
  }
}
