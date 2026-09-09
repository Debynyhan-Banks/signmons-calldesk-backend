// Parent-owned random local database; synthetic verified-context fixtures only.
// This is NOT Firebase/HTTP acceptance. No provider adapter or message send.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  CalendarPendingReviewService,
} = require("../dist/scheduling/calendar-pending-review.service.js");
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

export async function verifyCalendarPendingReview({
  prisma,
  jobData,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const journal = new CalendarOperationJournalService(prisma),
    review = new CalendarPendingReviewService(prisma);
  const ids = [];
  const asActor = (fn, role = "owner", tenantId = jobData.tenantId) =>
    new Promise((resolve, reject) => {
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({ userId: "synthetic-reviewer", tenantId, role });
        Promise.resolve().then(fn).then(resolve, reject);
      });
    });
  const make = async (action = "CREATE") => {
    const start = new Date(Date.UTC(2037, 0, ids.length + 1, 14)),
      end = new Date(start.getTime() + 3600000);
    const job = await prisma.job.create({
      data: {
        ...jobData,
        status: action === "CREATE" ? "CREATED" : "ACCEPTED",
        intakeSessionId: randomUUID(),
        assignedUserId: null,
        assignedUserTenantId: null,
        technicianStatus: null,
        calendarEventId: action === "CREATE" ? null : `fixture-${randomUUID()}`,
        serviceWindowStart:
          action === "CREATE" ? null : new Date(start.getTime() - 3600000),
        serviceWindowEnd: action === "CREATE" ? null : start,
      },
    });
    ids.push(job.id);
    const operation = await journal.reserve({
      tenantId: job.tenantId,
      jobId: job.id,
      expectedUpdatedAt: job.updatedAt,
      action,
      calendarId: "fixture@example.invalid",
      timeZone: "UTC",
      start,
      end,
      label: "Synthetic review window",
    });
    const claimed = await prisma.job.findUniqueOrThrow({
      where: { id: job.id },
    });
    return {
      job: claimed,
      operation,
      input: {
        operationId: operation.id,
        expectedUpdatedAt: operation.updatedAt.toISOString(),
        acknowledgeHold: true,
      },
    };
  };
  const readJob = (f) =>
    prisma.job.findUniqueOrThrow({ where: { id: f.job.id } });
  const readOperation = (f) =>
    prisma.calendarOperation.findUniqueOrThrow({
      where: { id: f.operation.id },
    });
  const audits = (f) =>
    prisma.auditLog.findMany({
      where: {
        entityId: f.operation.id,
        action: "appointment.pending_create_held",
      },
    });
  const untouched = async (f) => {
    assert.deepEqual(await readJob(f), f.job);
    assert.deepEqual(await readOperation(f), f.operation);
    assert.equal((await audits(f)).length, 0);
  };
  const intentsBefore = await prisma.smsEnqueueIntent.count(),
    messagesBefore = await prisma.communicationEvent.count();
  try {
    const unauthorized = await make();
    await assert.rejects(
      review.hold(unauthorized.input),
      (e) => e.getStatus() === 401,
    );
    // Explicit null avoids the helper's default owner argument.
    for (const role of ["dispatcher", "tech", "read_only", undefined])
      await assert.rejects(
        asActor(() => review.hold(unauthorized.input), role ?? null),
        (e) => e.getStatus() === 403,
      );
    await assert.rejects(
      asActor(() => review.hold(unauthorized.input), "owner", otherTenantId),
      (e) => e.getStatus() === 404,
    );
    await assert.rejects(
      asActor(() =>
        review.hold({ ...unauthorized.input, acknowledgeHold: false }),
      ),
      (e) => e.getStatus() === 400,
    );
    await assert.rejects(
      asActor(() =>
        review.hold({
          ...unauthorized.input,
          expectedUpdatedAt: new Date(0).toISOString(),
        }),
      ),
      (e) => e.getStatus() === 409,
    );
    await untouched(unauthorized);

    for (const role of ["owner", "admin"]) {
      const f = await make();
      assert.deepEqual(await asActor(() => review.hold(f.input), role), {
        status: "needs_review",
      });
      const held = await readOperation(f);
      assert.deepEqual(await readJob(f), f.job);
      assert.deepEqual(
        {
          ...held,
          status: f.operation.status,
          updatedAt: f.operation.updatedAt,
        },
        f.operation,
      );
      assert.equal(held.status, "NEEDS_REVIEW");
      assert.equal(held.finishedAt, null);
      assert.ok(held.updatedAt > f.operation.updatedAt);
      const audit = await audits(f);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actorId, "synthetic-reviewer");
      assert.deepEqual(audit[0].metadata, {
        jobId: f.job.id,
        reasonCode: "PENDING_CREATE_REVIEWED",
        acknowledged: true,
        reviewedUpdatedAt: f.input.expectedUpdatedAt,
      });
      await assert.rejects(
        asActor(() => review.hold(f.input), role),
        (e) => e.getStatus() === 409,
      );
      assert.equal((await audits(f)).length, 1);
    }
    for (const action of ["RESCHEDULE", "CANCEL"]) {
      const f = await make(action);
      await assert.rejects(
        asActor(() => review.hold(f.input)),
        (e) => e.getStatus() === 409,
      );
      await untouched(f);
    }
    for (const status of [
      "UNCERTAIN",
      "APPLIED",
      "NEEDS_REVIEW",
      "FINALIZED",
      "ABORTED",
    ]) {
      const f = await make();
      f.operation = await prisma.calendarOperation.update({
        where: { id: f.operation.id },
        data: {
          status,
          finishedAt: ["FINALIZED", "ABORTED"].includes(status)
            ? new Date()
            : null,
        },
      });
      f.input.expectedUpdatedAt = f.operation.updatedAt.toISOString();
      await assert.rejects(
        asActor(() => review.hold(f.input)),
        (e) => e.getStatus() === 409,
      );
      await untouched(f);
    }
    const concurrent = await make();
    const results = await Promise.allSettled([
      asActor(() => review.hold(concurrent.input)),
      asActor(() => review.hold(concurrent.input)),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await audits(concurrent)).length, 1);
    assert.deepEqual(await readJob(concurrent), concurrent.job);

    const rollback = await make();
    const broken = new CalendarPendingReviewService({
      $transaction: (fn) =>
        prisma.$transaction((tx) =>
          fn({
            ...tx,
            auditLog: {
              ...tx.auditLog,
              create: async (args) => {
                await tx.auditLog.create(args);
                throw new Error("Synthetic audit acknowledgment failure");
              },
            },
          }),
        ),
    });
    await assert.rejects(
      asActor(() => broken.hold(rollback.input)),
      /review status is uncertain/,
    );
    await untouched(rollback);
    const lostAck = await make();
    const unknown = new CalendarPendingReviewService({
      $transaction: async (fn) => {
        await prisma.$transaction(fn);
        throw new Error("Synthetic lost commit acknowledgment");
      },
    });
    await assert.rejects(
      asActor(() => unknown.hold(lostAck.input)),
      /review status is uncertain/,
    );
    assert.equal((await readOperation(lostAck)).status, "NEEDS_REVIEW");
    assert.equal((await audits(lostAck)).length, 1);
    assert.deepEqual(await readJob(lostAck), lostAck.job);
    await assert.rejects(
      asActor(() => review.hold(lostAck.input)),
      (e) => e.getStatus() === 409,
    );
    assert.equal((await audits(lostAck)).length, 1);

    let inserts = 0,
      reads = 0;
    const creator = {
      create: async () => {
        inserts++;
      },
    };
    const reader = {
      reconcile: async () => {
        reads++;
        return { status: "pending" };
      },
    };
    // Review commits after executor read but before its durable attempt latch.
    const reviewWins = await make();
    const staleExecutor = new CalendarCreateExecutionService(
      {
        ...prisma,
        calendarOperation: {
          ...prisma.calendarOperation,
          findUnique: async (args) => {
            const result = await prisma.calendarOperation.findUnique(args);
            await asActor(() => review.hold(reviewWins.input));
            return result;
          },
        },
        $transaction: prisma.$transaction.bind(prisma),
      },
      creator,
      reader,
    );
    assert.deepEqual(
      await staleExecutor.execute({
        tenantId: reviewWins.job.tenantId,
        operationId: reviewWins.operation.id,
      }),
      { status: "pending" },
    );
    assert.equal(inserts, 0);
    assert.equal(reads, 0);
    assert.deepEqual(await readJob(reviewWins), reviewWins.job);
    assert.equal((await readOperation(reviewWins)).status, "NEEDS_REVIEW");
    assert.equal((await audits(reviewWins)).length, 1);
    assert.deepEqual(
      await new CalendarCreateExecutionService(prisma, creator, reader).execute(
        {
          tenantId: reviewWins.job.tenantId,
          operationId: reviewWins.operation.id,
        },
      ),
      { status: "needs_review" },
    );
    assert.equal(inserts, 0);
    assert.equal(reads, 0);

    // Executor commits its latch/attempt before a stale review's conditional write.
    const executorWins = await make();
    const executor = new CalendarCreateExecutionService(
      prisma,
      creator,
      reader,
    );
    let winningJob, winningOperation;
    const staleReview = new CalendarPendingReviewService({
      $transaction: (fn) =>
        prisma.$transaction((tx) =>
          fn({
            ...tx,
            calendarOperation: {
              ...tx.calendarOperation,
              findUnique: async (args) => {
                const result = await tx.calendarOperation.findUnique(args);
                await executor.execute({
                  tenantId: executorWins.job.tenantId,
                  operationId: executorWins.operation.id,
                });
                winningJob = await readJob(executorWins);
                winningOperation = await readOperation(executorWins);
                return result;
              },
            },
          }),
        ),
    });
    await assert.rejects(
      asActor(() => staleReview.hold(executorWins.input)),
      (e) => e.getStatus() === 409,
    );
    assert.equal(inserts, 1);
    assert.equal(reads, 1);
    assert.deepEqual(await readJob(executorWins), winningJob);
    assert.deepEqual(await readOperation(executorWins), winningOperation);
    assert.equal(winningOperation.status, "APPLIED");
    assert.equal((await audits(executorWins)).length, 0);
    assert.equal(await prisma.smsEnqueueIntent.count(), intentsBefore);
    assert.equal(await prisma.communicationEvent.count(), messagesBefore);
    return [
      "PENDING review requires owner/admin context, exact tenant/version and explicit acknowledgment; other roles/actions/states refuse",
      "review changes journal status/version plus one bounded audit only; job/event/unfinished lock retained and repeat refused",
      "two concurrent reviews yield one hold/audit; audit failure rolls back actual writes; lost commit acknowledgment retains one audited hold",
      "both real executor/review race orders preserve winner: review prevents attempt, started executor blocks stale review",
      "no new intent/message/provider action or automatic PENDING restart; synthetic auth-context proof only",
    ];
  } finally {
    await prisma.calendarOperation.deleteMany({
      where: { tenantId: jobData.tenantId, jobId: { in: ids } },
    });
  }
}
