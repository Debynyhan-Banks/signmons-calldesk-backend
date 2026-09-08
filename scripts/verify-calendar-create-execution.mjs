// Parent-owned disposable database. Calendar insert/read are synthetic doubles.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const {
  CalendarOperationJournalService,
} = require("../dist/scheduling/calendar-operation-journal.service.js");
const {
  CalendarCreateExecutionService,
} = require("../dist/scheduling/calendar-create-execution.service.js");
const {
  CalendarCreateReconciliationService,
} = require("../dist/scheduling/calendar-create-reconciliation.service.js");
const databasePattern = /^calldesk_app013_intents_[0-9a-f]{12}$/;

export async function verifyCalendarCreateExecution({
  prisma,
  intents,
  jobData,
  otherTenantId,
}) {
  const [local] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(local.name, databasePattern);
  assert.equal(local.address, null);
  const ids = [],
    seen = new Map();
  const journal = new CalendarOperationJournalService(prisma);
  let inserts = 0;
  const reader = {
    read: async (_calendarId, eventId) =>
      seen.has(eventId)
        ? { outcome: "found", event: seen.get(eventId) }
        : { outcome: "unverified" },
  };
  const reconciliation = new CalendarCreateReconciliationService(
    prisma,
    reader,
    intents,
  );
  const creator = {
    create: async (request) => {
      inserts++;
      const saved = await prisma.calendarOperation.findUniqueOrThrow({
        where: { id: request.operationId },
      });
      assert.equal(saved.status, "UNCERTAIN");
      assert.equal(saved.calendarEventId, request.eventId);
      assert.equal(
        await prisma.smsEnqueueIntent.count({ where: { jobId: saved.jobId } }),
        0,
      );
      seen.set(request.eventId, snapshot(saved));
    },
  };
  const make = async () => {
    const start = new Date(Date.now() + (ids.length + 200) * 86400000),
      end = new Date(start.getTime() + 3600000);
    const job = await prisma.job.create({
      data: {
        ...jobData,
        status: "CREATED",
        assignedUserId: null,
        assignedUserTenantId: null,
        technicianStatus: null,
        intakeSessionId: randomUUID(),
      },
    });
    ids.push(job.id);
    const operation = await journal.reserve({
      tenantId: job.tenantId,
      jobId: job.id,
      expectedUpdatedAt: job.updatedAt,
      action: "CREATE",
      calendarId: "fixture@example.invalid",
      timeZone: "UTC",
      start,
      end,
      label: "Synthetic window",
    });
    return {
      operation,
      input: { tenantId: job.tenantId, operationId: operation.id },
    };
  };
  const execute = new CalendarCreateExecutionService(
    prisma,
    creator,
    reconciliation,
  );
  try {
    const first = await make();
    const outcomes = await Promise.all([
      execute.execute(first.input),
      execute.execute(first.input),
    ]);
    assert.equal(outcomes.filter((r) => r.status === "finalized").length, 1);
    assert.equal(inserts, 1);
    assert.equal(
      (await execute.execute(first.input)).status,
      "already_finalized",
    );
    assert.equal(inserts, 1);
    assert.equal(
      await prisma.smsEnqueueIntent.count({
        where: { jobId: first.operation.jobId },
      }),
      1,
    );
    assert.equal(
      await prisma.auditLog.count({
        where: {
          entityId: first.operation.jobId,
          action: "appointment.initial_confirmed",
        },
      }),
      1,
    );
    await assert.rejects(
      execute.execute({ ...first.input, tenantId: otherTenantId }),
      /not found/,
    );
    const unknown = await make();
    const unknownCreator = {
      create: async (request) => {
        await creator.create(request);
        throw new Error("lost insert acknowledgment");
      },
    };
    assert.equal(
      (
        await new CalendarCreateExecutionService(
          prisma,
          unknownCreator,
          reconciliation,
        ).execute(unknown.input)
      ).status,
      "finalized",
    );
    const absent = await make();
    const before = inserts;
    const absentCreator = {
      create: async () => {
        inserts++;
        throw new Error("unknown transport");
      },
    };
    assert.equal(
      (
        await new CalendarCreateExecutionService(
          prisma,
          absentCreator,
          reconciliation,
        ).execute(absent.input)
      ).status,
      "needs_review",
    );
    await execute.execute(absent.input);
    assert.equal(inserts, before + 1);
    assert.equal(
      await prisma.smsEnqueueIntent.count({
        where: { jobId: absent.operation.jobId },
      }),
      0,
    );

    const stale = await make();
    await prisma.job.update({
      where: { id: stale.operation.jobId },
      data: {
        description: "Newer user edit",
        updatedAt: new Date(stale.operation.claimedUpdatedAt.getTime() + 1000),
      },
    });
    assert.equal((await execute.execute(stale.input)).status, "needs_review");
    assert.equal(
      (
        await prisma.job.findUniqueOrThrow({
          where: { id: stale.operation.jobId },
        })
      ).description,
      "Newer user edit",
    );

    const acknowledgment = await make();
    const lostAckPrisma = {
      ...prisma,
      calendarOperation: prisma.calendarOperation,
      $transaction: async (fn) => {
        await prisma.$transaction(fn);
        throw new Error("commit acknowledgment lost");
      },
    };
    const beforeAck = inserts;
    await assert.rejects(
      new CalendarCreateExecutionService(
        lostAckPrisma,
        creator,
        reconciliation,
      ).execute(acknowledgment.input),
      /acknowledgment lost/,
    );
    assert.equal(
      (await execute.execute(acknowledgment.input)).status,
      "pending",
    );
    assert.equal(inserts, beforeAck);

    for (const mode of ["--before-insert", "--after-insert"]) {
      const fixture = await make();
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), mode, local.name],
        { stdio: ["pipe", "pipe", "pipe"], timeout: 15000 },
      );
      let output = "",
        diagnostic = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (diagnostic += chunk));
      const closed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      child.stdin.end(JSON.stringify(fixture.input));
      assert.equal(
        await closed,
        mode === "--before-insert" ? 81 : 82,
        diagnostic,
      );
      const afterCrash = await prisma.calendarOperation.findUniqueOrThrow({
        where: { id: fixture.operation.id },
      });
      assert.equal(afterCrash.status, "UNCERTAIN");
      assert.ok(
        afterCrash.claimedUpdatedAt > fixture.operation.claimedUpdatedAt,
      );
      const beforeRetry = inserts;
      assert.equal((await execute.execute(fixture.input)).status, "pending");
      assert.equal(inserts, beforeRetry);
      if (mode === "--after-insert") {
        assert.equal(JSON.parse(output).eventId, afterCrash.calendarEventId);
        seen.set(afterCrash.calendarEventId, snapshot(afterCrash));
        assert.equal(
          (await reconciliation.reconcile(fixture.input)).status,
          "finalized",
        );
        assert.equal(
          await prisma.smsEnqueueIntent.count({
            where: { jobId: fixture.operation.jobId },
          }),
          1,
        );
      } else {
        assert.equal(
          (await reconciliation.reconcile(fixture.input)).status,
          "needs_review",
        );
        assert.equal(
          await prisma.smsEnqueueIntent.count({
            where: { jobId: fixture.operation.jobId },
          }),
          0,
        );
      }
    }
    return [
      "one committed CREATE attempt under concurrent execution and replay",
      "insert acknowledgment is never finalization proof",
      "unknown insert outcome with matching read-back finalizes once",
      "absent evidence and stale jobs stay held without compensation",
      "lost attempt-commit acknowledgment never dispatches",
      "two process exits before/after synthetic insert retain latch and recover only by read-back",
    ];
  } finally {
    await prisma.calendarOperation.deleteMany({
      where: { jobId: { in: ids }, tenantId: jobData.tenantId },
    });
  }
}

function snapshot(operation) {
  return {
    id: operation.calendarEventId,
    etag: '"synthetic-version"',
    status: "confirmed",
    blockingSingleEvent: true,
    start: operation.desiredWindowStart.toISOString(),
    end: operation.desiredWindowEnd.toISOString(),
    tenantId: operation.tenantId,
    jobId: operation.jobId,
    operationId: operation.id,
  };
}

if (["--before-insert", "--after-insert"].includes(process.argv[2])) {
  const [mode, database] = process.argv.slice(2);
  assert.match(database, databasePattern);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString());
  const { Pool } = require("pg"),
    { PrismaClient } = require("@prisma/client"),
    { PrismaPg } = require("@prisma/adapter-pg");
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
  const creator = {
    create: async (request) => {
      if (mode === "--after-insert")
        await new Promise((resolve) =>
          process.stdout.write(
            JSON.stringify({ eventId: request.eventId }),
            resolve,
          ),
        );
      process.exit(mode === "--before-insert" ? 81 : 82);
    },
  };
  await new CalendarCreateExecutionService(prisma, creator, {
    reconcile: () => {
      throw new Error("Crash must precede finalization");
    },
  }).execute(input);
  throw new Error("Expected process exit");
}
