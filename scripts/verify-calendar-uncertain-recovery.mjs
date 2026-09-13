// Parent-owned disposable database. No real Calendar adapter or message sender.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  CalendarUncertainRecoveryService,
} = require("../dist/scheduling/calendar-uncertain-recovery.service.js");
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

export async function verifyCalendarUncertainRecovery({
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
  const recovery = new CalendarUncertainRecoveryService(prisma, reconciler);
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
    const start = new Date(Date.UTC(2042, 0, ids.length, 12));
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
    // Fixture simulates a persisted elapsed UNCERTAIN after the real attempt latch.
    await prisma.calendarOperation.update({
      where: { id: op.id },
      data: {
        status: "UNCERTAIN",
        updatedAt: new Date(Date.now() - 20_000),
        readbackNotBefore: null,
      },
    });
    const operation = await prisma.calendarOperation.findUniqueOrThrow({
      where: { id: op.id },
    });
    assert.equal(operation.status, "UNCERTAIN");
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
      (a) => a.action === "appointment.uncertain_create_readback_requested",
    );
  const messagesBefore = await prisma.communicationEvent.count();
  try {
    const boundaryCase = await make();
    const boundaryVersion = new Date(Date.now() + 1000);
    await prisma.calendarOperation.update({
      where: { id: boundaryCase.operation.id },
      data: { updatedAt: boundaryVersion, readbackNotBefore: null },
    });
    boundaryCase.input.expectedUpdatedAt = boundaryVersion.toISOString();
    const boundary = boundaryVersion.getTime() + 10_000;
    const beforeBoundary = await snapshot(boundaryCase);
    const realNow = Date.now;
    try {
      Date.now = () => boundary - 1;
      await assert.rejects(
        asActor(() => recovery.recover(boundaryCase.input)),
        (e) => e.getStatus() === 409,
      );
      assert.deepEqual(
        await reconciler.reconcile({
          tenantId: jobData.tenantId,
          operationId: boundaryCase.operation.id,
        }),
        { status: "pending" },
      );
      assert.deepEqual(await snapshot(boundaryCase), beforeBoundary);
      assert.equal(reads, 0);
      Date.now = () => boundary;
      assert.deepEqual(
        await asActor(() => recovery.recover(boundaryCase.input)),
        { status: "finalized" },
      );
      const done = await snapshot(boundaryCase);
      assert.equal(done.operation.readbackNotBefore.getTime(), boundary);
      assert.equal(done.intents.length, 1);
    } finally {
      Date.now = realNow;
    }
    // The remainder uses relative read counts; the exact-boundary case read once.
    reads = 0;

    const future = await make();
    await prisma.calendarOperation.update({
      where: { id: future.operation.id },
      data: {
        readbackNotBefore: new Date(Date.now() + 60_000),
        updatedAt: future.operation.updatedAt,
      },
    });
    const beforeFuture = await snapshot(future);
    await assert.rejects(
      asActor(() => recovery.recover(future.input)),
      (e) => e.getStatus() === 409,
    );
    assert.deepEqual(await snapshot(future), beforeFuture);
    assert.equal(reads, 0);

    const rollbackClock = await make();
    const beforeRollbackClockReads = reads;
    const clockChanged = new CalendarUncertainRecoveryService(prisma, {
      reconcile: async (args) => {
        const latest = await snapshot(rollbackClock);
        const originalNow = Date.now;
        try {
          Date.now = () => latest.operation.readbackNotBefore.getTime() - 1;
          return await reconciler.reconcile(args);
        } finally {
          Date.now = originalNow;
        }
      },
    });
    assert.deepEqual(
      await asActor(() => clockChanged.recover(rollbackClock.input)),
      { status: "pending" },
    );
    const clockHeld = await snapshot(rollbackClock);
    assert.equal(clockHeld.operation.status, "UNCERTAIN");
    assert.equal(
      clockHeld.operation.readbackNotBefore.getTime(),
      rollbackClock.operation.updatedAt.getTime() + 10_000,
    );
    assert.equal(reads, beforeRollbackClockReads);
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
      "APPLIED",
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
          "readbackNotBefore",
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
    const failedAudit = new CalendarUncertainRecoveryService(
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
    const unknownAdmission = new CalendarUncertainRecoveryService(
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
    assert.equal(admitted.operation.status, "UNCERTAIN");
    assert.equal(requestAudits(admitted).length, 1);
    assert.equal(admitted.intents.length, 0);
    assert.equal(
      admitted.operation.readbackNotBefore.getTime(),
      lostAck.operation.updatedAt.getTime() + 10_000,
    );
    assert.equal(reads, beforeAckReads);
    assert.deepEqual(admitted.job, beforeAdmission.job);
    assert.deepEqual(
      {
        ...admitted.operation,
        updatedAt: lostAck.operation.updatedAt,
        readbackNotBefore: null,
      },
      lostAck.operation,
    );
    await assert.rejects(
      asActor(() => recovery.recover(lostAck.input)),
      (e) => e.getStatus() === 409,
    );
    // Fresh service/context + explicit new review, never automatic restart/retry.
    assert.deepEqual(
      await asActor(() =>
        new CalendarUncertainRecoveryService(prisma, reconciler).recover({
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
    const changedAfterAdmission = new CalendarUncertainRecoveryService(prisma, {
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
        new CalendarUncertainRecoveryService(prisma, lateReader).recover(
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
        new CalendarUncertainRecoveryService(prisma, localReconciler).recover(
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
      if (outcome === "unavailable") {
        assert.equal(
          held.operation.readbackNotBefore.getTime(),
          held.operation.updatedAt.getTime() + 10_000,
        );
        const beforeRetry = await snapshot(f);
        await assert.rejects(
          asActor(() =>
            recovery.recover({
              ...f.input,
              expectedUpdatedAt: held.operation.updatedAt.toISOString(),
            }),
          ),
          (e) => e.getStatus() === 409,
        );
        assert.deepEqual(await snapshot(f), beforeRetry);
      }
    }
    assert.equal(await prisma.communicationEvent.count(), messagesBefore);
    return [
      "legacy null deadline refuses one millisecond before grace and admits exactly at boundary; persisted deadline survives new version",
      "future persisted deadline overrides old version; clock rollback after admission prevents provider read",
      "lost admission acknowledgment preserves original deadline; explicit refreshed review does not restart wait",
      "unavailable read sets persisted retry backoff and immediate reviewed retry refuses",
      "reviewed UNCERTAIN recovery enforces context/role/tenant/ack/version; every other status refuses without reads or writes",
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
