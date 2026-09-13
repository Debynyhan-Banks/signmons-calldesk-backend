// Invoked by the disposable PostgreSQL suite. All provider acknowledgments are
// synthetic. No email consumer, credentials, transport or production connections.
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
  AppointmentCancellationService,
} = require("../dist/scheduling/appointment-cancellation.service.js");
const {
  AppointmentReschedulingService,
} = require("../dist/scheduling/appointment-rescheduling.service.js");
const {
  SmsEnqueueIntentService,
} = require("../dist/communications/sms-enqueue-intent.service.js");
const {
  recordAppointmentEmailCancellation,
  recordAppointmentEmailReschedule,
} = require("../dist/communications/appointment-email-intent.js");
const pattern = /^calldesk_app013_intents_[0-9a-f]{12}$/;
const logger = { error() {} };
const services = (prisma, db = prisma) => {
  const sms = new SmsEnqueueIntentService(
    prisma,
    {},
    { smsDeliveryEnabled: false },
  );
  return {
    cancel: new AppointmentCancellationService(db, sms, logger),
    reschedule: new AppointmentReschedulingService(db, sms, logger),
  };
};
const current = (prisma, job) =>
  prisma.job.findUniqueOrThrow({ where: { id: job.id } });
const count = async (prisma, job) => ({
  snapshots: await prisma.appointmentCancellationSnapshot.count({
    where: { jobId: job.id },
  }),
  email: await prisma.appointmentEmailIntent.count({
    where: { jobId: job.id },
  }),
  sms: await prisma.smsEnqueueIntent.count({ where: { jobId: job.id } }),
  audits: await prisma.auditLog.count({ where: { entityId: job.id } }),
  messages: await prisma.communicationEvent.count({ where: { jobId: job.id } }),
});
const empty = (snapshots = 0) => ({
  snapshots,
  email: 0,
  sms: 0,
  audits: 0,
  messages: 0,
});
const complete = (snapshots = 0) => ({
  snapshots,
  email: 1,
  sms: 1,
  audits: 1,
  messages: 0,
});
const child = (mode, database, id) =>
  spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), mode, database, id],
    { encoding: "utf8", timeout: 15000 },
  );
const failWrites = (prisma, table) => ({
  $transaction: (fn) =>
    prisma.$transaction((tx) =>
      fn(
        new Proxy(tx, {
          get(target, key) {
            return key === table
              ? {
                  create() {
                    throw Error("synthetic-storage-failure");
                  },
                  createMany() {
                    throw Error("synthetic-storage-failure");
                  },
                }
              : target[key];
          },
        }),
      ),
    ),
});

export async function verifyAppointmentEmailChanges({
  prisma,
  jobData,
  otherTenantId,
}) {
  const [database] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(database.name, pattern);
  assert.equal(database.address, null);
  const tenantId = jobData.tenantId;
  const original = await prisma.tenantOrganization.findUniqueOrThrow({
    where: { id: tenantId },
  });
  const svc = services(prisma);
  let sequence = 0;
  const make = () =>
    prisma.job.create({
      data: {
        ...jobData,
        intakeSessionId: randomUUID(),
        status: "ACCEPTED",
        calendarEventId: `synthetic-${randomUUID()}`,
        serviceWindowStart: new Date(Date.UTC(2048, 0, ++sequence, 14)),
        serviceWindowEnd: new Date(Date.UTC(2048, 0, sequence, 16)),
      },
    });
  const claim = (kind, job) =>
    kind === "cancel"
      ? svc.cancel.claim(job, "synthetic prior window")
      : svc.reschedule.claim(
          job,
          new Date(job.serviceWindowStart.getTime() + 365 * 86400000),
          new Date(job.serviceWindowEnd.getTime() + 365 * 86400000),
          "synthetic new window",
        );
  const finalize = (kind, job, service = svc) =>
    kind === "cancel"
      ? service.cancel.finalize(job)
      : service.reschedule.finalize(job, "old", "new");
  try {
    for (const kind of ["cancel", "reschedule"]) {
      const eventKind =
        kind === "cancel" ? "APPOINTMENT_CANCELLED" : "APPOINTMENT_RESCHEDULED";
      for (const disposition of ["BLOCKED", "PERMITTED", "INVALID"]) {
        const settings =
          disposition === "BLOCKED"
            ? {}
            : {
                customerEmailPreferences:
                  disposition === "INVALID"
                    ? { version: 99 }
                    : {
                        version: 1,
                        events: {
                          APPOINTMENT_CONFIRMED: false,
                          APPOINTMENT_CANCELLED: kind === "cancel",
                          APPOINTMENT_RESCHEDULED: kind === "reschedule",
                        },
                      },
              };
        await prisma.tenantOrganization.update({
          where: { id: tenantId },
          data: { settings },
        });
        const job = await make(),
          claimed = await claim(kind, job);
        assert.ok(claimed.updatedAt > job.updatedAt);
        assert.deepEqual(
          await count(prisma, job),
          empty(kind === "cancel" ? 1 : 0),
        );
        const persisted = child("--read", database.name, job.id);
        assert.equal(persisted.status, 0, persisted.stderr);
        const recovered = JSON.parse(persisted.stdout);
        assert.equal(recovered.events.length, 0);
        assert.equal(recovered.snapshots.length, kind === "cancel" ? 1 : 0);
        if (kind === "cancel") {
          assert.equal(claimed.serviceWindowStart, null);
          assert.equal(
            recovered.snapshots[0].windowStart,
            job.serviceWindowStart.toISOString(),
          );
          const snapshot =
            await prisma.appointmentCancellationSnapshot.findFirstOrThrow({
              where: { jobId: job.id },
            });
          await assert.rejects(
            () =>
              prisma.appointmentCancellationSnapshot.update({
                where: {
                  tenantId_jobId_claimedUpdatedAt: {
                    tenantId,
                    jobId: job.id,
                    claimedUpdatedAt: claimed.updatedAt,
                  },
                },
                data: { windowStart: new Date(0) },
              }),
            /immutable/,
          );
          await assert.rejects(() =>
            prisma.appointmentCancellationSnapshot.create({
              data: { ...snapshot, tenantId: otherTenantId },
            }),
          );
        }
        await finalize(kind, claimed);
        const final = await current(prisma, job);
        const event = await prisma.appointmentEmailIntent.findFirstOrThrow({
          where: { jobId: job.id },
        });
        assert.equal(event.kind, eventKind);
        assert.equal(event.preference, disposition);
        assert.equal(event.source, "CALENDAR_ACK");
        assert.equal(event.calendarOperationId, null);
        assert.equal(event.state, "RECORDED");
        assert.deepEqual(event.jobUpdatedAt, final.updatedAt);
        assert.equal(event.customerId, job.customerId);
        assert.equal(event.intakeSessionId, job.intakeSessionId);
        assert.deepEqual(
          event.windowStart,
          kind === "cancel"
            ? job.serviceWindowStart
            : claimed.serviceWindowStart,
        );
        assert.deepEqual(
          event.windowEnd,
          kind === "cancel" ? job.serviceWindowEnd : claimed.serviceWindowEnd,
        );
        assert.equal(
          event.calendarEventHash,
          createHash("sha256").update(job.calendarEventId).digest("hex"),
        );
        assert.doesNotMatch(
          JSON.stringify(event),
          /synthetic-|managementUrl|recipient|subject|encryptedEmail/,
        );
        await assert.rejects(() => finalize(kind, claimed), /changed/);
        const record =
          kind === "cancel"
            ? recordAppointmentEmailCancellation
            : recordAppointmentEmailReschedule;
        await assert.rejects(
          () =>
            prisma.$transaction((tx) =>
              record(tx, {
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
        await prisma.job.update({
          where: { id: job.id },
          data: {
            updatedAt: new Date(final.updatedAt.getTime() + 1),
            intakeSessionId: randomUUID(),
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
        if (kind === "cancel")
          await assert.rejects(
            async () => svc.cancel.assertFinalized(await current(prisma, job)),
            /office/,
          );
        const restarted = child("--read", database.name, job.id);
        assert.equal(restarted.status, 0, restarted.stderr);
        assert.equal(
          JSON.parse(restarted.stdout).events[0].windowStart,
          event.windowStart.toISOString(),
        );
        assert.deepEqual(
          await count(prisma, job),
          complete(kind === "cancel" ? 1 : 0),
        );
      }
      const job = await make(),
        claimed = await claim(kind, job);
      await assert.rejects(
        () =>
          finalize(
            kind,
            claimed,
            services(prisma, failWrites(prisma, "appointmentEmailIntent")),
          ),
        /synthetic-storage-failure/,
      );
      assert.deepEqual(await current(prisma, job), claimed);
      assert.deepEqual(
        await count(prisma, job),
        empty(kind === "cancel" ? 1 : 0),
      );
      const outcomes = await Promise.allSettled([
        finalize(kind, claimed),
        finalize(kind, claimed),
      ]);
      assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
      assert.deepEqual(
        await count(prisma, job),
        complete(kind === "cancel" ? 1 : 0),
      );
      // Exercise real SQL provenance refusals, not only mocked empty SELECTs.
      for (const invalid of [
        "actor",
        "action",
        "receipt-version",
        "sms",
        "tenant",
      ]) {
        const candidate = await make(),
          reservation = await claim(kind, candidate);
        const db = {
          $transaction: (fn) =>
            prisma.$transaction((tx) =>
              fn(
                new Proxy(tx, {
                  get(target, key) {
                    if (key !== "auditLog") return target[key];
                    return {
                      create: ({ data }) =>
                        tx.auditLog.create({
                          data: {
                            ...data,
                            ...(invalid === "actor"
                              ? { actorId: "customer:wrong" }
                              : {}),
                            ...(invalid === "action"
                              ? { action: "appointment.unrelated" }
                              : {}),
                            ...(invalid === "tenant"
                              ? { tenantId: otherTenantId }
                              : {}),
                            metadata: {
                              ...data.metadata,
                              ...(invalid === "receipt-version"
                                ? {
                                    finalizedUpdatedAt:
                                      reservation.updatedAt.toISOString(),
                                  }
                                : {}),
                              ...(invalid === "sms"
                                ? { notificationIntentId: randomUUID() }
                                : {}),
                            },
                          },
                        }),
                    };
                  },
                }),
              ),
            ),
        };
        await assert.rejects(
          () => finalize(kind, reservation, services(prisma, db)),
          /current finalized/,
        );
        assert.deepEqual(await current(prisma, candidate), reservation);
        assert.deepEqual(
          await count(prisma, candidate),
          empty(kind === "cancel" ? 1 : 0),
        );
      }
    }
    // Failed snapshot write cannot clear the active window.
    const failed = await make();
    await assert.rejects(
      () =>
        services(
          prisma,
          failWrites(prisma, "appointmentCancellationSnapshot"),
        ).cancel.claim(failed, "window"),
      /synthetic-storage-failure/,
    );
    assert.deepEqual(await current(prisma, failed), failed);
    assert.deepEqual(await count(prisma, failed), empty());
    // Capture is rolled back if the subsequent compare-and-swap cannot claim.
    const casFailure = {
      $transaction: (fn) =>
        prisma.$transaction((tx) =>
          fn(
            new Proxy(tx, {
              get(target, key) {
                return key === "job"
                  ? { updateMany: async () => ({ count: 0 }) }
                  : target[key];
              },
            }),
          ),
        ),
    };
    await assert.rejects(
      () => services(prisma, casFailure).cancel.claim(failed, "window"),
      /changed/,
    );
    assert.deepEqual(await current(prisma, failed), failed);
    assert.deepEqual(await count(prisma, failed), empty());
    const raced = await make();
    const races = await Promise.allSettled([
      claim("cancel", raced),
      claim("cancel", raced),
    ]);
    assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
    assert.deepEqual(await count(prisma, raced), empty(1));
    // Legacy cleared rows and mismatched snapshot identity/version cannot finalize.
    for (const mutation of ["missing-snapshot", "session", "version"]) {
      const job = await make();
      const claimed =
        mutation === "missing-snapshot"
          ? await prisma.job.update({
              where: { id: job.id },
              data: {
                status: "CANCELLED",
                calendarEventId: null,
                serviceWindowStart: null,
                serviceWindowEnd: null,
              },
            })
          : await claim("cancel", job);
      if (mutation === "session")
        await prisma.job.update({
          where: { id: job.id },
          data: { intakeSessionId: randomUUID() },
        });
      if (mutation === "version")
        await prisma.job.update({
          where: { id: job.id },
          data: { updatedAt: new Date(claimed.updatedAt.getTime() + 1) },
        });
      const latest = await current(prisma, job);
      await assert.rejects(
        () => finalize("cancel", latest),
        /current finalized/,
      );
      assert.deepEqual(await current(prisma, job), latest);
      assert.deepEqual(
        await count(prisma, job),
        empty(mutation === "missing-snapshot" ? 0 : 1),
      );
    }
    // A restored attempt remains historical; only a later exact claim can finalize.
    const job = await make(),
      first = await claim("cancel", job);
    assert.equal((await svc.cancel.restore(first, job)).count, 1);
    const restored = await current(prisma, job);
    assert.ok(restored.updatedAt > first.updatedAt);
    await assert.rejects(() => finalize("cancel", first), /changed/);
    const second = await claim("cancel", restored);
    await finalize("cancel", second);
    const final = await current(prisma, job);
    await svc.cancel.assertFinalized(final);
    const later = await prisma.job.update({
      where: { id: job.id },
      data: { updatedAt: new Date(final.updatedAt.getTime() + 1) },
    });
    await assert.rejects(() => svc.cancel.assertFinalized(later), /office/);
    assert.deepEqual(await count(prisma, job), complete(2));
    // Real process exits, not exception-only simulations: atomic claim and finalization.
    for (const operation of ["claim", "cancel", "reschedule"]) {
      for (const timing of ["before", "after"]) {
        const job = await make();
        const target =
          operation === "claim" ? job : await claim(operation, job);
        const result = child(`--${operation}-${timing}`, database.name, job.id);
        assert.equal(
          result.status,
          timing === "before" ? 86 : 87,
          result.stderr,
        );
        const committed = timing === "after";
        if (operation === "claim") {
          assert.deepEqual(await count(prisma, job), empty(committed ? 1 : 0));
          const latest = await current(prisma, job);
          assert.equal(latest.status, committed ? "CANCELLED" : "ACCEPTED");
          if (committed) {
            assert.equal(latest.serviceWindowStart, null);
            await assert.rejects(
              () => svc.cancel.assertFinalized(latest),
              /office/,
            );
          } else {
            assert.deepEqual(latest, job);
            await claim("cancel", job);
          }
          assert.deepEqual(await count(prisma, job), empty(1));
        } else {
          assert.deepEqual(
            await count(prisma, job),
            committed
              ? complete(operation === "cancel" ? 1 : 0)
              : empty(operation === "cancel" ? 1 : 0),
          );
          if (committed)
            await assert.rejects(() => finalize(operation, target), /changed/);
          else {
            assert.deepEqual(await current(prisma, job), target);
            await finalize(operation, target);
          }
          assert.deepEqual(
            await count(prisma, job),
            complete(operation === "cancel" ? 1 : 0),
          );
        }
      }
    }
    const summary = {
      result: "PASS",
      scope:
        "Reschedule/cancellation immutable events and pre-clear cancellation claims; no delivery admission",
      preferenceCases: 6,
      freshProcessReads: 12,
      newProcessCrashes: 6,
      providerCalls: 0,
      checks: [
        "Pre-clear snapshot survives restart without a final event",
        "Exact new reschedule and prior cancellation windows/hash/version",
        "Six independent preference cases",
        "Immutable snapshot/event updates and cross-tenant snapshot FK refused",
        "Historical receipt, missing snapshot, changed session/version refused",
        "Ten real SQL actor/action/receipt-version/SMS/tenant provenance refusals",
        "Failed claim CAS rolls back snapshot; concurrent claims retain one snapshot",
        "Snapshot failure preserves active job; event failure rolls back finalization",
        "Concurrent finalization single winner for both kinds",
        "Restore/reclaim retains distinct immutable snapshots; old claim cannot finalize",
        "Cancellation replay requires exact current finalized version",
        "Six process exits around claim and both finalization commits",
        "No credentials, email consumer or external transport",
      ],
    };
    const directory =
      process.env.EMAIL_CHANGE_EVIDENCE_DIR ??
      fileURLToPath(
        new URL("../evidence/APP-013/email-change-intents/", import.meta.url),
      );
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "database-summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
    );
    return summary.checks.map((s) => "email changes: " + s);
  } finally {
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings: original.settings },
    });
  }
}

if (
  /^--(read|(claim|cancel|reschedule)-(before|after))$/.test(
    process.argv[2] ?? "",
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
    const [check] = await prisma.$queryRawUnsafe(
      "SELECT current_database() AS name, inet_server_addr() AS address",
    );
    assert.equal(check.name, database);
    assert.equal(check.address, null);
    if (mode === "--read")
      console.log(
        JSON.stringify({
          snapshots: await prisma.appointmentCancellationSnapshot.findMany({
            where: { jobId: id },
          }),
          events: await prisma.appointmentEmailIntent.findMany({
            where: { jobId: id },
          }),
        }),
      );
    else {
      const job = await current(prisma, { id });
      const db = {
        $transaction: async (fn) => {
          const result = await prisma.$transaction(async (tx) => {
            const value = await fn(tx);
            if (mode.endsWith("before")) process.exit(86);
            return value;
          });
          process.exit(87);
          return result;
        },
      };
      const svc = services(prisma, db);
      if (mode.startsWith("--claim")) await svc.cancel.claim(job, "window");
      else if (mode.startsWith("--cancel")) await svc.cancel.finalize(job);
      else await svc.reschedule.finalize(job, "old", "new");
      throw Error("Expected process termination");
    }
  } finally {
    await prisma.$disconnect();
    if (!pool.ended) await pool.end();
  }
}
