// Local-only journal/read-back/finalization integration and process-crash proof.
// Never imports the real Calendar reader. Every provider response is synthetic.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
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
  CALENDAR_CREATE_READER_GRACE_MS,
} = require("../dist/scheduling/calendar-event-creator.js");
const {
  SmsEnqueueIntentService,
} = require("../dist/communications/sms-enqueue-intent.service.js");
const databasePattern = /^calldesk_app013_intents_[0-9a-f]{12}$/;
const snapshot = (operation) => ({
  outcome: "found",
  event: {
    id: operation.calendarEventId,
    status: "confirmed",
    etag: '"synthetic-version"',
    start: operation.desiredWindowStart.toISOString(),
    end: operation.desiredWindowEnd.toISOString(),
    tenantId: operation.tenantId,
    jobId: operation.jobId,
    operationId: operation.id,
    blockingSingleEvent: true,
  },
});
const reader = (prisma) => ({
  read: async (calendarId, calendarEventId) => {
    const operation = await prisma.calendarOperation.findFirstOrThrow({
      where: { calendarId, calendarEventId },
    });
    return snapshot(operation);
  },
});

export async function verifyCalendarCreateReconciliation({
  prisma,
  intents,
  disabled,
  jobData,
  otherTenantId,
}) {
  const [{ database, address }] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS database, inet_server_addr() AS address",
  );
  assert.match(database, databasePattern);
  assert.equal(address, null);
  let sequence = 0;
  const create = async () => {
    sequence += 1;
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
    const start = new Date(Date.UTC(2036, 0, sequence, 14));
    const operation = await new CalendarOperationJournalService(prisma).reserve(
      {
        tenantId: job.tenantId,
        jobId: job.id,
        expectedUpdatedAt: job.updatedAt,
        action: "CREATE",
        calendarId: "readback@example.invalid",
        timeZone: "UTC",
        start,
        end: new Date(start.getTime() + 3600000),
        label: "Synthetic arrival",
      },
    );
    const input = { tenantId: job.tenantId, operationId: operation.id };
    // Read-back fixtures must have passed the real durable attempt latch.
    // The creator is synthetic and immediate recovery is deferred to each test.
    let attempted = 0;
    await new CalendarCreateExecutionService(
      prisma,
      {
        create: async () => {
          attempted++;
        },
      },
      { reconcile: async () => ({ status: "pending" }) },
    ).execute(input);
    assert.equal(attempted, 1);
    const saved = await prisma.calendarOperation.findUniqueOrThrow({
      where: { id: operation.id },
    });
    assert.equal(saved.status, "APPLIED");
    return {
      job,
      operation: saved,
      input,
    };
  };
  const readOperation = (fixture) =>
    prisma.calendarOperation.findUniqueOrThrow({
      where: { id: fixture.operation.id },
    });
  const expireUncertain = (fixture) =>
    prisma.calendarOperation.updateMany({
      where: { id: fixture.operation.id, status: "UNCERTAIN" },
      data: {
        updatedAt: new Date(Date.now() - CALENDAR_CREATE_READER_GRACE_MS - 1),
      },
    });
  const readJob = (fixture) =>
    prisma.job.findUniqueOrThrow({ where: { id: fixture.job.id } });
  const audits = (fixture) =>
    prisma.auditLog.findMany({
      where: {
        tenantId: jobData.tenantId,
        entityId: fixture.job.id,
        action: "appointment.initial_confirmed",
      },
    });
  const intentRows = (fixture) =>
    prisma.smsEnqueueIntent.findMany({
      where: { tenantId: jobData.tenantId, jobId: fixture.job.id },
    });
  const service = new CalendarCreateReconciliationService(
    prisma,
    reader(prisma),
    intents,
  );
  const baselineMessages = await prisma.communicationEvent.count();
  const assertUnfinalized = async (fixture) => {
    assert.equal(
      await prisma.appointmentEmailIntent.count({
        where: { jobId: fixture.job.id },
      }),
      0,
    );
    assert.equal((await readJob(fixture)).calendarEventId, null);
    assert.equal((await readOperation(fixture)).finishedAt, null);
    assert.equal((await audits(fixture)).length, 0);
    assert.equal((await intentRows(fixture)).length, 0);
  };
  const assertFinalized = async (fixture) => {
    assert.equal((await readOperation(fixture)).status, "FINALIZED");
    assert.ok((await readOperation(fixture)).finishedAt);
    assert.equal(
      (await readJob(fixture)).calendarEventId,
      fixture.operation.calendarEventId,
    );
    assert.ok(
      (await readJob(fixture)).updatedAt > fixture.operation.claimedUpdatedAt,
    );
    const [audit] = await audits(fixture);
    const [intent] = await intentRows(fixture);
    assert.equal((await audits(fixture)).length, 1);
    assert.equal((await intentRows(fixture)).length, 1);
    assert.equal(intent.status, "PENDING");
    assert.equal(audit.metadata.notificationIntentId, intent.id);
    assert.equal(audit.metadata.calendarOperationId, fixture.operation.id);
    assert.match(audit.metadata.observedEventEtagHash, /^[0-9a-f]{64}$/);
    assert.equal(audit.actorType, "SYSTEM_AI");
    const email = await prisma.appointmentEmailIntent.findUniqueOrThrow({
      where: {
        sourceAuditId_tenantId: {
          sourceAuditId: audit.id,
          tenantId: jobData.tenantId,
        },
      },
    });
    assert.equal(email.source, "CREATE_READBACK");
    assert.equal(email.calendarOperationId, fixture.operation.id);
    assert.equal(
      email.jobUpdatedAt.toISOString(),
      audit.metadata.finalizedUpdatedAt,
    );
    assert.deepEqual(email.windowStart, fixture.operation.desiredWindowStart);
    assert.deepEqual(email.windowEnd, fixture.operation.desiredWindowEnd);
    assert.equal(email.state, "RECORDED");
    assert.ok(!JSON.stringify(audit.metadata).includes("synthetic-version"));
  };
  const success = await create();
  assert.deepEqual(await service.reconcile(success.input), {
    status: "finalized",
  });
  await assertFinalized(success);
  assert.deepEqual(await service.reconcile(success.input), {
    status: "already_finalized",
  });
  const [savedIntent] = await intentRows(success);
  await disabled.processOne({
    tenantId: success.job.tenantId,
    intentId: savedIntent.id,
  });
  assert.equal((await intentRows(success))[0].status, "PENDING");
  await assert.rejects(
    service.reconcile({ ...success.input, tenantId: otherTenantId }),
    /was not found/,
  );

  for (const outcome of ["unavailable", "unverified", "mismatched"]) {
    const fixture = await create();
    const unavailableReader = {
      read: async () =>
        outcome === "mismatched"
          ? {
              ...snapshot(fixture.operation),
              event: {
                ...snapshot(fixture.operation).event,
                operationId: randomUUID(),
              },
            }
          : { outcome },
    };
    const unavailable = new CalendarCreateReconciliationService(
      prisma,
      unavailableReader,
      intents,
    );
    assert.deepEqual(await unavailable.reconcile(fixture.input), {
      status: outcome === "unavailable" ? "pending" : "needs_review",
    });
    await assertUnfinalized(fixture);
    if (outcome === "unavailable") {
      assert.deepEqual(await service.reconcile(fixture.input), {
        status: "pending",
      });
      assert.equal((await expireUncertain(fixture)).count, 1);
      assert.deepEqual(await service.reconcile(fixture.input), {
        status: "finalized",
      });
      await assertFinalized(fixture);
    } else {
      assert.deepEqual(await service.reconcile(fixture.input), {
        status: "needs_review",
      });
      await assertUnfinalized(fixture);
    }
  }

  // Fail after real writes at different boundaries, not just a mocked promise.
  for (const stage of ["job", "intent", "audit"]) {
    const fixture = await create();
    const wrapped = {
      calendarOperation: prisma.calendarOperation,
      job: prisma.job,
      $transaction: (callback) =>
        prisma.$transaction((tx) =>
          callback({
            ...tx,
            job:
              stage === "job"
                ? {
                    ...tx.job,
                    updateMany: async (args) => {
                      await tx.job.updateMany(args);
                      throw new Error("after job update");
                    },
                  }
                : tx.job,
            smsEnqueueIntent:
              stage === "intent"
                ? {
                    ...tx.smsEnqueueIntent,
                    upsert: async (args) => {
                      await tx.smsEnqueueIntent.upsert(args);
                      throw new Error("after intent insertion");
                    },
                  }
                : tx.smsEnqueueIntent,
            auditLog:
              stage === "audit"
                ? {
                    ...tx.auditLog,
                    create: async (args) => {
                      await tx.auditLog.create(args);
                      throw new Error("after audit insertion");
                    },
                  }
                : tx.auditLog,
          }),
        ),
    };
    assert.deepEqual(
      await new CalendarCreateReconciliationService(
        wrapped,
        reader(prisma),
        intents,
      ).reconcile(fixture.input),
      { status: "pending" },
    );
    await assertUnfinalized(fixture);
    assert.deepEqual(await service.reconcile(fixture.input), {
      status: "pending",
    });
    assert.equal((await expireUncertain(fixture)).count, 1);
    assert.deepEqual(await service.reconcile(fixture.input), {
      status: "finalized",
    });
    await assertFinalized(fixture);
  }

  const ackLost = await create();
  const lostCommit = {
    calendarOperation: prisma.calendarOperation,
    job: prisma.job,
    $transaction: async (callback) => {
      await prisma.$transaction(callback);
      throw new Error("commit acknowledgment lost");
    },
  };
  assert.deepEqual(
    await new CalendarCreateReconciliationService(
      lostCommit,
      reader(prisma),
      intents,
    ).reconcile(ackLost.input),
    { status: "already_finalized" },
  );
  await assertFinalized(ackLost);

  const concurrent = await create();
  const concurrentResults = await Promise.all([
    service.reconcile(concurrent.input),
    service.reconcile(concurrent.input),
  ]);
  assert.equal(
    concurrentResults.filter((r) => r.status === "finalized").length,
    1,
  );
  await assertFinalized(concurrent);

  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const late = await create();
  const entered = deferred();
  const response = deferred();
  const lateService = new CalendarCreateReconciliationService(
    prisma,
    {
      read: () => {
        entered.resolve();
        return response.promise;
      },
    },
    intents,
  );
  const lateResult = lateService.reconcile(late.input);
  await entered.promise;
  await service.reconcile(late.input);
  response.resolve({ outcome: "unavailable" });
  assert.deepEqual(await lateResult, { status: "already_finalized" });
  await assertFinalized(late);

  const reviewed = await create();
  const reviewEntered = deferred();
  const reviewResponse = deferred();
  const oldGoodRead = new CalendarCreateReconciliationService(
    prisma,
    {
      read: () => {
        reviewEntered.resolve();
        return reviewResponse.promise;
      },
    },
    intents,
  ).reconcile(reviewed.input);
  await reviewEntered.promise;
  await new CalendarCreateReconciliationService(
    prisma,
    { read: async () => ({ outcome: "unverified" }) },
    intents,
  ).reconcile(reviewed.input);
  reviewResponse.resolve(snapshot(reviewed.operation));
  assert.deepEqual(await oldGoodRead, { status: "needs_review" });
  await assertUnfinalized(reviewed);

  const changed = await create();
  const changedEntered = deferred();
  const changedResponse = deferred();
  const changedService = new CalendarCreateReconciliationService(
    prisma,
    {
      read: () => {
        changedEntered.resolve();
        return changedResponse.promise;
      },
    },
    intents,
  );
  const changedResult = changedService.reconcile(changed.input);
  await changedEntered.promise;
  const updated = await prisma.job.update({
    where: { id: changed.job.id },
    data: {
      preferredTimeText: "Newer operator edit",
      updatedAt: new Date(changed.operation.claimedUpdatedAt.getTime() + 1000),
    },
  });
  changedResponse.resolve(snapshot(changed.operation));
  assert.deepEqual(await changedResult, { status: "needs_review" });
  await assertUnfinalized(changed);
  assert.deepEqual(await readJob(changed), updated);

  for (const [mode, expectedExit] of [
    ["--after-read", 75],
    ["--before-finalize-commit", 76],
    ["--after-finalize-commit", 77],
  ]) {
    const fixture = await create();
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), mode, database],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 15000 },
    );
    child.stdout.resume();
    let diagnostic = "";
    child.stderr.on("data", (chunk) => {
      diagnostic += chunk;
    });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) =>
        signal
          ? reject(new Error(`Crash fixture ${signal}: ${diagnostic}`))
          : resolve(code),
      );
    });
    child.stdin.end(JSON.stringify(fixture.input));
    assert.equal(await closed, expectedExit, diagnostic);
    if (mode === "--after-finalize-commit") {
      await assertFinalized(fixture);
      assert.deepEqual(await service.reconcile(fixture.input), {
        status: "already_finalized",
      });
    } else {
      await assertUnfinalized(fixture);
      assert.deepEqual(await service.reconcile(fixture.input), {
        status: "finalized",
      });
      await assertFinalized(fixture);
    }
  }
  assert.equal(await prisma.communicationEvent.count(), baselineMessages);
  await prisma.calendarOperation.deleteMany({
    where: {
      tenantId: jobData.tenantId,
      calendarId: "readback@example.invalid",
    },
  });
  return [
    "CREATE read-back identity/window validation and atomic four-record finalization",
    "unverified/conflicting evidence held without writes to Calendar",
    "temporary read failure recovers on fresh read",
    "rollback after real job/intent/audit writes",
    "lost finalization commit acknowledgment recognizes receipt",
    "concurrent and late-reader protection",
    "newer job edit survives stale Calendar observation",
    "three process exits after read/before commit/after commit recover safely",
    "one intent and audit on replay with zero queue/provider calls",
  ];
}

if (
  [
    "--after-read",
    "--before-finalize-commit",
    "--after-finalize-commit",
  ].includes(process.argv[2])
) {
  const mode = process.argv[2];
  const database = process.argv[3];
  assert.match(database, databasePattern);
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const { Pool } = require("pg");
  const { PrismaPg } = require("@prisma/adapter-pg");
  const { PrismaClient } = require("@prisma/client");
  const pool = new Pool({
    host: "/tmp",
    port: 5432,
    user: userInfo().username,
    database,
    options: "-c search_path=public",
  });
  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool, { schema: "public" }),
  });
  const [{ address, database: actual }] = await prisma.$queryRawUnsafe(
    "SELECT inet_server_addr() AS address, current_database() AS database",
  );
  assert.equal(address, null);
  assert.equal(actual, database);
  const intents = new SmsEnqueueIntentService(
    prisma,
    {},
    { smsDeliveryEnabled: false },
  );
  const read = reader(prisma);
  const wrapped = {
    job: prisma.job,
    calendarOperation: prisma.calendarOperation,
    $transaction: async (callback) => {
      const result = await prisma.$transaction(async (tx) => {
        const result = await callback(tx);
        if (mode === "--before-finalize-commit") process.exit(76);
        return result;
      });
      if (mode === "--after-finalize-commit") process.exit(77);
      return result;
    },
  };
  await new CalendarCreateReconciliationService(
    wrapped,
    {
      read: async (...args) => {
        const result = await read.read(...args);
        if (mode === "--after-read") process.exit(75);
        return result;
      },
    },
    intents,
  ).reconcile(input);
  throw new Error("Expected the crash fixture to terminate");
}
