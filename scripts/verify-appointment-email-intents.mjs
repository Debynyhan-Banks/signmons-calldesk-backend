// Disposable Unix-socket PostgreSQL only. Calendar acknowledgment is synthetic.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const {
  AppointmentConfirmationService,
} = require("../dist/scheduling/appointment-confirmation.service.js");
const {
  SmsEnqueueIntentService,
} = require("../dist/communications/sms-enqueue-intent.service.js");
const {
  recordAppointmentEmailConfirmation,
} = require("../dist/communications/appointment-email-intent.js");
const pattern = /^calldesk_app013_intents_[0-9a-f]{12}$/;
const logger = { error() {} };
const input = (job) => ({
  tenantId: job.tenantId,
  jobId: job.id,
  start: job.serviceWindowStart,
  end: job.serviceWindowEnd,
  calendarEventId: "synthetic-email-confirmation",
});

export async function verifyAppointmentEmailIntents({
  prisma,
  jobData,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, pattern);
  assert.equal(db.address, null);
  const tenantId = jobData.tenantId;
  const original = await prisma.tenantOrganization.findUniqueOrThrow({
    where: { id: tenantId },
  });
  const intents = new SmsEnqueueIntentService(
    prisma,
    {},
    { smsDeliveryEnabled: false },
  );
  const finalizer = new AppointmentConfirmationService(prisma, intents, logger);
  let sequence = 0;
  const make = () =>
    prisma.job.create({
      data: {
        ...jobData,
        intakeSessionId: randomUUID(),
        status: "ACCEPTED",
        calendarEventId: null,
        serviceWindowStart: new Date(Date.UTC(2042, 0, ++sequence, 14)),
        serviceWindowEnd: new Date(Date.UTC(2042, 0, sequence, 16)),
      },
    });
  const counts = async (job) => ({
    email: await prisma.appointmentEmailIntent.count({
      where: { jobId: job.id },
    }),
    sms: await prisma.smsEnqueueIntent.count({ where: { jobId: job.id } }),
    audits: await prisma.auditLog.count({
      where: { entityId: job.id, action: "appointment.initial_confirmed" },
    }),
    messages: await prisma.communicationEvent.count({
      where: { jobId: job.id },
    }),
  });
  try {
    for (const [settings, preference] of [
      [{}, "BLOCKED"],
      [
        {
          customerEmailPreferences: {
            version: 1,
            events: {
              APPOINTMENT_CONFIRMED: true,
              APPOINTMENT_RESCHEDULED: false,
              APPOINTMENT_CANCELLED: false,
            },
          },
        },
        "PERMITTED",
      ],
      [{ customerEmailPreferences: { version: 99, events: {} } }, "INVALID"],
    ]) {
      await prisma.tenantOrganization.update({
        where: { id: tenantId },
        data: { settings },
      });
      const job = await make();
      assert.deepEqual(await counts(job), {
        email: 0,
        sms: 0,
        audits: 0,
        messages: 0,
      });
      const confirmed = await finalizer.finalize(input(job));
      const [event] = await prisma.appointmentEmailIntent.findMany({
        where: { jobId: job.id },
      });
      assert.equal(event.preference, preference);
      assert.equal(event.source, "CALENDAR_ACK");
      assert.equal(event.state, "RECORDED");
      assert.equal(event.kind, "APPOINTMENT_CONFIRMED");
      assert.equal(
        event.jobUpdatedAt.toISOString(),
        confirmed.updatedAt.toISOString(),
      );
      assert.deepEqual(event.windowStart, job.serviceWindowStart);
      assert.deepEqual(event.windowEnd, job.serviceWindowEnd);
      assert.equal(
        event.calendarEventHash,
        createHash("sha256").update(input(job).calendarEventId).digest("hex"),
      );
      assert.equal(event.customerId, job.customerId);
      assert.equal(event.intakeSessionId, job.intakeSessionId);
      assert.doesNotMatch(
        JSON.stringify(event),
        /synthetic-email-confirmation|encryptedEmail|managementUrl|recipient|subject/,
      );
      assert.deepEqual(await counts(job), {
        email: 1,
        sms: 1,
        audits: 1,
        messages: 0,
      });
      await assert.rejects(() => finalizer.finalize(input(job)), /changed/);
      // Committed audits may be read as evidence, never used for new backfill.
      await assert.rejects(
        () =>
          prisma.$transaction((tx) =>
            recordAppointmentEmailConfirmation(tx, {
              tenantId,
              jobId: job.id,
              sourceAuditId: event.sourceAuditId,
            }),
          ),
        /current finalized/,
      );
      await assert.rejects(
        () =>
          prisma.appointmentEmailIntent.update({
            where: { id: event.id },
            data: { preference: "BLOCKED" },
          }),
        /immutable/,
      );
      await assert.rejects(() =>
        prisma.appointmentEmailIntent.create({
          data: { ...event, id: randomUUID(), tenantId: otherTenantId },
        }),
      );
      await prisma.job.update({
        where: { id: job.id },
        data: {
          serviceWindowStart: new Date(
            job.serviceWindowStart.getTime() + 365 * 86400000,
          ),
          serviceWindowEnd: new Date(
            job.serviceWindowEnd.getTime() + 365 * 86400000,
          ),
          status: "CANCELLED",
          calendarEventId: null,
        },
      });
      await prisma.tenantOrganization.update({
        where: { id: tenantId },
        data: { settings: {} },
      });
      assert.deepEqual(
        await prisma.appointmentEmailIntent.findUniqueOrThrow({
          where: { id: event.id },
        }),
        event,
      );
      const restarted = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "--read-intent", db.name, event.id],
        { encoding: "utf8", timeout: 15000 },
      );
      assert.equal(restarted.status, 0, restarted.stderr);
      const persisted = JSON.parse(restarted.stdout);
      assert.equal(persisted.id, event.id);
      assert.equal(persisted.windowStart, event.windowStart.toISOString());
      assert.equal(persisted.preference, event.preference);
    }
    const rollback = await make();
    const broken = new AppointmentConfirmationService(
      {
        $transaction: (fn) =>
          prisma.$transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(target, key) {
                  return key === "appointmentEmailIntent"
                    ? {
                        createMany() {
                          throw Error("synthetic-intent-write-failure");
                        },
                      }
                    : target[key];
                },
              }),
            ),
          ),
      },
      intents,
      logger,
    );
    await assert.rejects(
      () => broken.finalize(input(rollback)),
      /synthetic-intent-write-failure/,
    );
    assert.deepEqual(await counts(rollback), {
      email: 0,
      sms: 0,
      audits: 0,
      messages: 0,
    });
    assert.deepEqual(
      await prisma.job.findUniqueOrThrow({ where: { id: rollback.id } }),
      rollback,
    );
    const concurrent = await make();
    const results = await Promise.allSettled([
      finalizer.finalize(input(concurrent)),
      finalizer.finalize(input(concurrent)),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.deepEqual(await counts(concurrent), {
      email: 1,
      sms: 1,
      audits: 1,
      messages: 0,
    });
    for (const [mode, exitCode, committed] of [
      ["--before-commit", 86, false],
      ["--after-commit", 87, true],
    ]) {
      const job = await make();
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), mode, db.name, job.id],
        { encoding: "utf8", timeout: 15000 },
      );
      assert.equal(child.status, exitCode, child.stderr);
      assert.deepEqual(await counts(job), {
        email: committed ? 1 : 0,
        sms: committed ? 1 : 0,
        audits: committed ? 1 : 0,
        messages: 0,
      });
      if (committed)
        await assert.rejects(() => finalizer.finalize(input(job)), /changed/);
      else await finalizer.finalize(input(job));
      assert.deepEqual(await counts(job), {
        email: 1,
        sms: 1,
        audits: 1,
        messages: 0,
      });
    }
    const summary = {
      result: "PASS",
      scope:
        "Initial confirmation only; recorded event, not delivery admission",
      preferenceCases: 3,
      freshProcessReads: 3,
      newProcessCrashes: 2,
      providerCalls: 0,
      checks: [
        "No event before finalization",
        "Exact immutable event/window/version snapshots",
        "Default-off/permitted/invalid preference snapshots",
        "Old receipt backfill refused",
        "Database UPDATE and cross-tenant FK refused",
        "Later job/policy edits do not rewrite snapshots",
        "Intent failure rolls back job/SMS/audit",
        "Concurrent finalization single winner",
        "Before/after commit process exits retain zero/one atomic event; replay stays one",
      ],
    };
    const directory =
      process.env.EMAIL_INTENT_EVIDENCE_DIR ??
      fileURLToPath(
        new URL("../evidence/APP-013/email-intents/", import.meta.url),
      );
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "database-summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
    );
    return summary.checks.map((s) => "email intent: " + s);
  } finally {
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings: original.settings },
    });
  }
}

if (
  ["--read-intent", "--before-commit", "--after-commit"].includes(
    process.argv[2],
  )
) {
  const [, , mode, database, id] = process.argv;
  assert.match(database, pattern);
  assert.match(id, /^[0-9a-f-]{36}$/);
  const { Pool } = require("pg"),
    { PrismaClient } = require("@prisma/client"),
    { PrismaPg } = require("@prisma/adapter-pg");
  const pool = new Pool({ host: "/tmp", user: userInfo().username, database });
  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool, { schema: "public" }),
  });
  try {
    const [db] = await prisma.$queryRawUnsafe(
      "SELECT current_database() AS name, inet_server_addr() AS address",
    );
    assert.equal(db.name, database);
    assert.equal(db.address, null);
    if (mode === "--read-intent") {
      const event = await prisma.appointmentEmailIntent.findUniqueOrThrow({
        where: { id },
        select: { id: true, windowStart: true, preference: true },
      });
      console.log(JSON.stringify(event));
    } else {
      const job = await prisma.job.findUniqueOrThrow({ where: { id } });
      const db = {
        $transaction: async (fn) => {
          const result = await prisma.$transaction(async (tx) => {
            const result = await fn(tx);
            if (mode === "--before-commit") process.exit(86);
            return result;
          });
          if (mode === "--after-commit") process.exit(87);
          return result;
        },
      };
      await new AppointmentConfirmationService(
        db,
        new SmsEnqueueIntentService(prisma, {}, { smsDeliveryEnabled: false }),
        logger,
      ).finalize(input(job));
      throw Error("Expected fixture process termination");
    }
  } finally {
    await prisma.$disconnect();
    if (!pool.ended) await pool.end();
  }
}
