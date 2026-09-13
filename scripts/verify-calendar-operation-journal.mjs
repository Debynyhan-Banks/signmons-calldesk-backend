// Foundation proof only. The parent owns a disposable Unix-socket database.
// Child exit modes deliberately simulate process loss; no provider is imported.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const {
  CalendarOperationJournalService,
} = require("../dist/scheduling/calendar-operation-journal.service.js");

const localDatabasePattern = /^calldesk_app013_intents_[0-9a-f]{12}$/;
async function crashChild(database, input, mode) {
  assert.match(database, localDatabasePattern);
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), mode, database],
    {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    },
  );
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk;
  });
  child.stdout.resume();
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal)
        reject(
          new Error(`Crash fixture terminated by ${signal}: ${diagnostic}`),
        );
      else resolve(code);
    });
  });
  child.stdin.end(JSON.stringify(input));
  assert.equal(await closed, mode === "--before-commit" ? 73 : 74, diagnostic);
}

export async function verifyCalendarOperationJournal({
  prisma,
  jobData,
  otherTenantId,
}) {
  const [{ database, address }] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS database, inet_server_addr() AS address",
  );
  assert.match(database, localDatabasePattern);
  assert.equal(address, null);
  const service = new CalendarOperationJournalService(prisma);
  let sequence = 0;
  const create = async (action = "CREATE") => {
    sequence += 1;
    const start = new Date(Date.UTC(2035, 0, sequence, 14));
    const end = new Date(start.getTime() + 3600000);
    const job = await prisma.job.create({
      data: {
        ...jobData,
        intakeSessionId: randomUUID(),
        status: action === "CREATE" ? "CREATED" : "ACCEPTED",
        calendarEventId: action === "CREATE" ? null : `fixture-${randomUUID()}`,
        serviceWindowStart:
          action === "CREATE" ? null : new Date(start.getTime() - 3600000),
        serviceWindowEnd: action === "CREATE" ? null : start,
        preferredTimeText:
          action === "CREATE" ? null : "Original synthetic window",
      },
    });
    return {
      job,
      input: {
        tenantId: job.tenantId,
        jobId: job.id,
        expectedUpdatedAt: job.updatedAt,
        calendarId: "fixture@example.invalid",
        timeZone: "America/New_York",
        action,
        ...(action === "CANCEL"
          ? {}
          : { start, end, label: "Synthetic arrival window" }),
      },
    };
  };
  const readJob = (job) =>
    prisma.job.findUniqueOrThrow({ where: { id: job.id } });
  const operations = (job) =>
    prisma.calendarOperation.findMany({
      where: { jobId: job.id, tenantId: job.tenantId },
    });
  const intentCount = await prisma.smsEnqueueIntent.count();
  const auditCount = await prisma.auditLog.count();
  const messageCount = await prisma.communicationEvent.count();
  const created = await create();
  const operation = await service.reserve(created.input);
  assert.match(operation.calendarEventId, /^[0-9a-f]{32}$/);
  assert.equal(operation.status, "PENDING");
  assert.equal(operation.finishedAt, null);
  assert.equal(operation.previousStatus, "CREATED");
  assert.equal((await readJob(created.job)).status, "ACCEPTED");
  assert.equal((await readJob(created.job)).calendarEventId, null);
  assert.equal(
    (await readJob(created.job)).updatedAt.getTime(),
    operation.claimedUpdatedAt.getTime(),
  );
  assert.ok(operation.claimedUpdatedAt > created.job.updatedAt);
  assert.equal(
    (await operations(created.job))[0].calendarEventId,
    operation.calendarEventId,
  );

  for (const action of ["RESCHEDULE", "CANCEL"]) {
    const fixture = await create(action);
    const record = await service.reserve(fixture.input);
    const claimed = await readJob(fixture.job);
    assert.equal(record.calendarEventId, fixture.job.calendarEventId);
    assert.equal(record.previousCalendarEventId, fixture.job.calendarEventId);
    assert.deepEqual(
      record.previousWindowStart,
      fixture.job.serviceWindowStart,
    );
    assert.equal(record.previousTimeText, fixture.job.preferredTimeText);
    assert.equal(
      claimed.status,
      action === "CANCEL" ? "CANCELLED" : "ACCEPTED",
    );
    assert.equal(
      claimed.calendarEventId,
      action === "CANCEL" ? null : fixture.job.calendarEventId,
    );
    assert.deepEqual(
      claimed.serviceWindowStart,
      action === "CANCEL" ? null : fixture.input.start,
    );
  }

  // Actual process termination, not a thrown JS exception or an in-memory mock.
  for (const action of ["CREATE", "RESCHEDULE", "CANCEL"]) {
    const before = await create(action);
    await crashChild(database, before.input, "--before-commit");
    assert.deepEqual(await readJob(before.job), before.job);
    assert.equal((await operations(before.job)).length, 0);
    const after = await create(action);
    await crashChild(database, after.input, "--after-commit");
    const [surviving] = await operations(after.job);
    assert.equal(surviving.status, "PENDING");
    assert.deepEqual(
      surviving.previousWindowStart,
      after.job.serviceWindowStart,
    );
    assert.deepEqual(
      (await readJob(after.job)).updatedAt,
      surviving.claimedUpdatedAt,
    );
    // A restarted service cannot silently start another operation.
    await assert.rejects(
      new CalendarOperationJournalService(prisma).reserve(after.input),
      /Appointment changed/,
    );
    assert.equal((await operations(after.job)).length, 1);
  }

  const rollback = await create();
  const broken = new CalendarOperationJournalService({
    $transaction: (callback) =>
      prisma.$transaction((tx) =>
        callback({
          ...tx,
          calendarOperation: {
            ...tx.calendarOperation,
            create: async (args) => {
              await tx.calendarOperation.create(args);
              throw new Error("failure after actual journal insert");
            },
          },
        }),
      ),
  });
  await assert.rejects(
    broken.reserve(rollback.input),
    /failure after actual journal insert/,
  );
  assert.deepEqual(await readJob(rollback.job), rollback.job);
  assert.equal((await operations(rollback.job)).length, 0);

  const race = await create("RESCHEDULE");
  const results = await Promise.allSettled([
    service.reserve(race.input),
    service.reserve({ ...race.input, action: "CANCEL" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await operations(race.job)).length, 1);
  const fresh = await readJob(race.job);
  for (const status of ["PENDING", "UNCERTAIN", "APPLIED", "NEEDS_REVIEW"]) {
    const [active] = await operations(race.job);
    await prisma.calendarOperation.update({
      where: { id: active.id },
      data: { status },
    });
    await assert.rejects(
      service.reserve({ ...race.input, expectedUpdatedAt: fresh.updatedAt }),
      /Appointment changed/,
    );
    const { id: _id, ...copy } = active;
    await assert.rejects(
      prisma.calendarOperation.create({
        data: { ...copy, id: randomUUID(), status },
      }),
      { code: "P2002" },
    );
  }

  const wrong = await create();
  await assert.rejects(
    service.reserve({ ...wrong.input, tenantId: otherTenantId }),
    /Appointment changed/,
  );
  await assert.rejects(
    service.reserve({ ...wrong.input, expectedUpdatedAt: new Date(0) }),
    /Appointment changed/,
  );
  await prisma.job.update({
    where: { id: wrong.job.id },
    data: { deletedAt: new Date() },
  });
  await assert.rejects(
    service.reserve({
      ...wrong.input,
      expectedUpdatedAt: (await readJob(wrong.job)).updatedAt,
    }),
    /Appointment changed/,
  );
  const { id: _id, ...copy } = operation;
  await assert.rejects(
    prisma.calendarOperation.create({
      data: { ...copy, id: randomUUID(), tenantId: otherTenantId },
    }),
    { code: "P2003" },
  );
  await assert.rejects(prisma.job.delete({ where: { id: created.job.id } }), {
    code: "P2003",
  });
  await assert.rejects(
    prisma.tenantOrganization.delete({ where: { id: created.job.tenantId } }),
    { code: "P2003" },
  );
  await assert.rejects(
    prisma.calendarOperation.update({
      where: { id: operation.id },
      data: { status: "FINALIZED" },
    }),
  );
  await assert.rejects(
    prisma.calendarOperation.update({
      where: { id: operation.id },
      data: { desiredWindowEnd: operation.desiredWindowStart },
    }),
  );
  await assert.rejects(
    prisma.calendarOperation.update({
      where: { id: operation.id },
      data: { claimedUpdatedAt: operation.expectedUpdatedAt },
    }),
  );

  // CREATE admission must survive migration from legacy booking to the journal.
  // All payment mutations below are fictional local race setup, never providers.
  const makePaymentCase = async (policySnapshot, status) => {
    const fixture = await create();
    fixture.job = await prisma.job.update({
      where: { id: fixture.job.id },
      data: { policySnapshot },
    });
    fixture.input.expectedUpdatedAt = fixture.job.updatedAt;
    fixture.payment = status
      ? await prisma.payment.create({
          data: {
            tenantId: fixture.job.tenantId,
            jobId: fixture.job.id,
            jobTenantId: fixture.job.tenantId,
            status,
            amountTotalCents: 100,
            applicationFeeAmountCents: 0,
            currency: "usd",
          },
        })
      : null;
    return fixture;
  };
  for (const required of ["depositRequired", "serviceFeeRequired"]) {
    for (const status of [null, "PENDING", "FAILED", "CANCELED", "REFUNDED"]) {
      const fixture = await makePaymentCase({ [required]: true }, status);
      await assert.rejects(
        service.reserve(fixture.input),
        /Appointment changed/,
      );
      assert.deepEqual(await readJob(fixture.job), fixture.job);
      assert.equal((await operations(fixture.job)).length, 0);
    }
  }
  const exceptionPolicy = {
    depositRequired: true,
    paymentGateMode: "manual_override",
    paymentGateException: {
      active: true,
      approvedAt: new Date().toISOString(),
      reason: "Synthetic approved exception",
    },
  };
  for (const [policy, status] of [
    [{ depositRequired: true }, "SUCCEEDED"],
    [{ depositRequired: false, serviceFeeRequired: false }, "FAILED"],
    [exceptionPolicy, "FAILED"],
  ]) {
    const fixture = await makePaymentCase(policy, status);
    const journal = await service.reserve(fixture.input);
    assert.equal(journal.status, "PENDING");
    assert.equal((await readJob(fixture.job)).status, "ACCEPTED");
    assert.equal((await operations(fixture.job)).length, 1);
    assert.deepEqual(
      await prisma.payment.findUnique({ where: { id: fixture.payment.id } }),
      fixture.payment,
    );
    await assert.rejects(service.reserve(fixture.input), /Appointment changed/);
    assert.equal((await operations(fixture.job)).length, 1);
  }
  for (const mutation of [
    "refund",
    "version",
    "replacement",
    "exception-revocation",
  ]) {
    const fixture = await makePaymentCase(
      mutation === "exception-revocation"
        ? exceptionPolicy
        : { depositRequired: true },
      mutation === "exception-revocation" ? "FAILED" : "SUCCEEDED",
    );
    let winningPayment = fixture.payment;
    let winningJob = fixture.job;
    let claims = 0;
    const competing = new CalendarOperationJournalService({
      $transaction: (callback) =>
        prisma.$transaction((tx) =>
          callback({
            ...tx,
            job: {
              ...tx.job,
              updateMany: async (args) => {
                claims++;
                if (mutation === "exception-revocation") {
                  winningJob = await prisma.job.update({
                    where: { id: fixture.job.id },
                    data: {
                      policySnapshot: {
                        ...exceptionPolicy,
                        paymentGateException: {
                          ...exceptionPolicy.paymentGateException,
                          active: false,
                        },
                      },
                      updatedAt: new Date(
                        fixture.job.updatedAt.getTime() + 1000,
                      ),
                    },
                  });
                } else if (mutation === "replacement") {
                  winningPayment = await prisma.$transaction(async (other) => {
                    await other.payment.delete({
                      where: { id: fixture.payment.id },
                    });
                    return other.payment.create({
                      data: { ...fixture.payment, id: randomUUID() },
                    });
                  });
                } else {
                  winningPayment = await prisma.payment.update({
                    where: { id: fixture.payment.id },
                    data: {
                      status: mutation === "refund" ? "REFUNDED" : "SUCCEEDED",
                      updatedAt: new Date(
                        fixture.payment.updatedAt.getTime() + 1000,
                      ),
                    },
                  });
                }
                return tx.job.updateMany(args);
              },
            },
          }),
        ),
    });
    await assert.rejects(
      competing.reserve(fixture.input),
      /Appointment changed/,
    );
    assert.equal(claims, 1);
    assert.deepEqual(await readJob(fixture.job), winningJob);
    assert.deepEqual(
      await prisma.payment.findFirst({ where: { jobId: fixture.job.id } }),
      winningPayment,
    );
    assert.equal((await operations(fixture.job)).length, 0);
  }
  const paidRollback = await makePaymentCase(
    { depositRequired: true },
    "SUCCEEDED",
  );
  await assert.rejects(
    broken.reserve(paidRollback.input),
    /failure after actual journal insert/,
  );
  assert.deepEqual(await readJob(paidRollback.job), paidRollback.job);
  assert.equal((await operations(paidRollback.job)).length, 0);
  assert.deepEqual(
    await prisma.payment.findUnique({ where: { id: paidRollback.payment.id } }),
    paidRollback.payment,
  );

  assert.equal(await prisma.smsEnqueueIntent.count(), intentCount);
  assert.equal(await prisma.auditLog.count(), auditCount);
  assert.equal(await prisma.communicationEvent.count(), messageCount);
  // Parent cleanup may delete its tenant only after explicit fixture journal removal.
  await prisma.calendarOperation.deleteMany({
    where: { tenantId: jobData.tenantId },
  });
  return [
    "CREATE journal payment admission: ten unpaid refusals and three allowed one-journal/replay refusals",
    "CREATE journal payment claim: committed refund/version/replacement and policy-revocation races preserve winners",
    "CREATE journal paid insertion failure rolls back job/journal and preserves payment",
    "journal atomic reservation for create/reschedule/cancel",
    "six real child-process crashes before/after commit",
    "durable target and snapshot after restart",
    "rollback after actual journal insertion",
    "one concurrent reschedule/cancel claim",
    "partial uniqueness for all unfinished states",
    "stale/deleted/cross-tenant refusal and composite FK",
    "hard-delete protection and database CHECK constraints",
    "no success audit, SMS intent or message before finalization",
  ];
}

if (["--before-commit", "--after-commit"].includes(process.argv[2])) {
  const mode = process.argv[2];
  const database = process.argv[3];
  assert.match(database, localDatabasePattern);
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  for (const key of ["expectedUpdatedAt", "start", "end"])
    if (input[key]) input[key] = new Date(input[key]);
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
  if (mode === "--before-commit") {
    await prisma.$transaction(async (tx) => {
      const service = new CalendarOperationJournalService({
        $transaction: (callback) => callback(tx),
      });
      await service.reserve(input);
      process.exit(73); // Socket loss forces PostgreSQL to roll back the transaction.
    });
  } else {
    await new CalendarOperationJournalService(prisma).reserve(input);
    process.exit(74); // Commit acknowledged; no finalization or external call follows.
  }
}
