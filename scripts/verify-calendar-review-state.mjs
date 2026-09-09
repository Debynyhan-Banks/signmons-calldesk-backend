// Disposable parent-owned DB only. Context fixtures are NOT Firebase/HTTP acceptance.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  CalendarReviewStateService,
} = require("../dist/scheduling/calendar-review-state.service.js");
const {
  CalendarPendingReviewService,
} = require("../dist/scheduling/calendar-pending-review.service.js");
const {
  CalendarOperationJournalService,
} = require("../dist/scheduling/calendar-operation-journal.service.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");

export async function verifyCalendarReviewState({
  prisma,
  jobData,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const state = new CalendarReviewStateService(prisma);
  const hold = new CalendarPendingReviewService(prisma);
  const journal = new CalendarOperationJournalService(prisma);
  const ids = [];
  const asActor = (fn, role = "owner", tenantId = jobData.tenantId) =>
    new Promise((resolve, reject) => {
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({ userId: "synthetic-reviewer", tenantId, role });
        Promise.resolve().then(fn).then(resolve, reject);
      });
    });
  const make = async (action = "CREATE") => {
    const start = new Date(Date.UTC(2038, 0, ids.length + 1, 12)),
      end = new Date(start.getTime() + 3600000);
    const job = await prisma.job.create({
      data: {
        ...jobData,
        intakeSessionId: randomUUID(),
        status: action === "CREATE" ? "CREATED" : "ACCEPTED",
        assignedUserId: null,
        assignedUserTenantId: null,
        technicianStatus: null,
        calendarEventId: action === "CREATE" ? null : "private-fixture-event",
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
      calendarId: "private-calendar@example.invalid",
      timeZone: "UTC",
      ...(action === "CANCEL"
        ? {}
        : { start, end, label: "Private synthetic arrival text" }),
    });
    return { job, operation };
  };
  const read = (f) =>
    asActor(() => state.read({ operationId: f.operation.id }));
  const list = (f) => asActor(() => state.listForJob({ jobId: f.job.id }));
  const snapshot = async () => ({
    jobs: await prisma.job.findMany({
      where: { id: { in: ids } },
      orderBy: { id: "asc" },
    }),
    operations: await prisma.calendarOperation.findMany({
      where: { jobId: { in: ids } },
      orderBy: { id: "asc" },
    }),
    audits: await prisma.auditLog.count(),
    intents: await prisma.smsEnqueueIntent.count(),
    messages: await prisma.communicationEvent.count(),
  });
  const keys = [
    "snapshotOnly",
    "operationId",
    "jobId",
    "action",
    "status",
    "createdAt",
    "updatedAt",
    "finishedAt",
    "pendingHoldReviewCandidate",
  ].sort();
  try {
    const current = await make();
    const variants = [];
    for (const status of [
      "UNCERTAIN",
      "APPLIED",
      "NEEDS_REVIEW",
      "FINALIZED",
      "ABORTED",
    ]) {
      const f = await make();
      await prisma.calendarOperation.update({
        where: { id: f.operation.id },
        data: {
          status,
          finishedAt: ["FINALIZED", "ABORTED"].includes(status)
            ? new Date()
            : null,
        },
      });
      variants.push({ f, status });
    }
    for (const action of ["RESCHEDULE", "CANCEL"])
      variants.push({ f: await make(action), status: "PENDING" });
    // 101 rows for one job, with deliberately tied creation timestamps. The old
    // PENDING row is outside the capped history; exact refresh must still find it.
    const history = Array.from({ length: 100 }, () => ({
      ...current.operation,
      id: randomUUID(),
      status: "FINALIZED",
      createdAt: new Date("2040-01-01T00:00:00.000Z"),
      finishedAt: new Date("2040-01-01T00:00:00.000Z"),
    }));
    await prisma.calendarOperation.createMany({ data: history });
    const before = await snapshot();
    await assert.rejects(
      state.listForJob({ jobId: current.job.id }),
      (e) => e.getStatus() === 401,
    );
    await assert.rejects(
      state.read({ operationId: current.operation.id }),
      (e) => e.getStatus() === 401,
    );
    for (const role of ["dispatcher", "tech", "read_only", null]) {
      await assert.rejects(
        asActor(() => state.listForJob({ jobId: current.job.id }), role),
        (e) => e.getStatus() === 403,
      );
      await assert.rejects(
        asActor(() => state.read({ operationId: current.operation.id }), role),
        (e) => e.getStatus() === 403,
      );
    }
    assert.deepEqual(
      await asActor(
        () => state.listForJob({ jobId: current.job.id }),
        "owner",
        otherTenantId,
      ),
      { snapshotOnly: true, items: [], hasMore: false },
    );
    await assert.rejects(
      asActor(
        () => state.read({ operationId: current.operation.id }),
        "admin",
        otherTenantId,
      ),
      (e) => e.getStatus() === 404,
    );
    await assert.rejects(
      asActor(() => state.read({ operationId: randomUUID() })),
      (e) => e.getStatus() === 404,
    );
    assert.deepEqual(
      await asActor(() => state.listForJob({ jobId: randomUUID() })),
      { snapshotOnly: true, items: [], hasMore: false },
    );

    for (const role of ["owner", "admin"]) {
      const result = await asActor(
        () => state.listForJob({ jobId: current.job.id }),
        role,
      );
      assert.equal(result.snapshotOnly, true);
      assert.equal(result.hasMore, true);
      assert.equal(result.items.length, 100);
      assert.deepEqual(
        result.items.map((r) => r.operationId),
        history
          .map((r) => r.id)
          .sort()
          .reverse(),
      );
      for (const item of result.items) {
        assert.deepEqual(Object.keys(item).sort(), keys);
        assert.equal(item.pendingHoldReviewCandidate, false);
      }
      assert.ok(!JSON.stringify(result).includes("private-"));
    }
    const exact = await read(current);
    assert.deepEqual(Object.keys(exact).sort(), keys);
    assert.equal(exact.pendingHoldReviewCandidate, true);
    assert.equal(exact.updatedAt, current.operation.updatedAt.toISOString());
    assert.ok(!JSON.stringify(exact).includes("private-"));
    for (const { f, status } of variants) {
      const detail = await read(f),
        history = await list(f);
      assert.equal(detail.status, status);
      assert.equal(detail.action, f.operation.action);
      assert.equal(detail.pendingHoldReviewCandidate, false);
      assert.deepEqual(history.items, [detail]);
      assert.equal(history.hasMore, false);
      assert.deepEqual(Object.keys(detail).sort(), keys);
    }
    assert.deepEqual(await snapshot(), before); // Reads have zero persisted side effects.
    await asActor(() =>
      hold.hold({
        operationId: exact.operationId,
        expectedUpdatedAt: exact.updatedAt,
        acknowledgeHold: true,
      }),
    );
    const afterHold = await snapshot();
    const refreshed = await read(current);
    assert.equal(refreshed.status, "NEEDS_REVIEW");
    assert.equal(refreshed.pendingHoldReviewCandidate, false);
    assert.notEqual(refreshed.updatedAt, exact.updatedAt);
    assert.deepEqual(await snapshot(), afterHold);

    // An observed candidate is not authority: a later committed attempt wins.
    const racing = await make(),
      stale = await read(racing);
    await prisma.calendarOperation.update({
      where: { id: racing.operation.id },
      data: {
        status: "UNCERTAIN",
        updatedAt: new Date(racing.operation.updatedAt.getTime() + 1),
      },
    });
    const winner = await snapshot();
    await assert.rejects(
      asActor(() =>
        hold.hold({
          operationId: stale.operationId,
          expectedUpdatedAt: stale.updatedAt,
          acknowledgeHold: true,
        }),
      ),
      (e) => e.getStatus() === 409,
    );
    assert.equal((await read(racing)).pendingHoldReviewCandidate, false);
    assert.deepEqual(await snapshot(), winner);
    return [
      "read-only owner/admin tenant-scoped job history and exact refresh; missing/cross-tenant boundaries",
      "101 persisted rows prove 100-item truncation, stable UUID tie ordering and exact lookup outside history cap",
      "all actions/statuses project allowlisted metadata only; exact job/journal/audit/intent/message snapshots unchanged by reads",
      "projected version feeds existing reviewed hold; refreshed held state is not a candidate and reads write nothing",
      "committed attempt after projected candidate makes stale hold fail 409; exact winner retained without audit",
    ];
  } finally {
    await prisma.calendarOperation.deleteMany({
      where: { tenantId: jobData.tenantId, jobId: { in: ids } },
    });
  }
}
