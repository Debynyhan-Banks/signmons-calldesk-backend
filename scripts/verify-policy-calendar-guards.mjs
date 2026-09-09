// Parent-owned random local PostgreSQL fixture only; no provider calls.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  CalendarOperationJournalService,
} = require("../dist/scheduling/calendar-operation-journal.service.js");
const {
  UrgencyReviewService,
} = require("../dist/jobs/urgency-review.service.js");
const {
  PaymentRequestsService,
} = require("../dist/payments/payment-requests.service.js");

export async function verifyPolicyCalendarGuards({
  prisma,
  jobData,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const ids = [],
    tenantId = jobData.tenantId;
  const forbidden = () => {
    throw new Error("No external provider is permitted");
  };
  const services = (client) => ({
    urgency: new UrgencyReviewService(client, {
      notifyUrgencyEscalation: forbidden,
    }),
    payment: new PaymentRequestsService(client, {
      createCheckout: forbidden,
      recoverCheckout: forbidden,
    }),
  });
  const normal = services(prisma),
    journal = new CalendarOperationJournalService(prisma);
  const mutate = (service, kind, job, action = "APPROVE") =>
    kind === "urgency"
      ? service.urgency.override({
          tenantId: job.tenantId,
          jobId: job.id,
          actorId: jobData.assignedUserId,
          urgency: "HIGH",
          reason: "Synthetic policy review",
        })
      : service.payment.governException({
          tenantId: job.tenantId,
          jobId: job.id,
          actorId: jobData.assignedUserId,
          traceId: "synthetic",
          action,
          reason: "Synthetic policy review",
          expectedJobUpdatedAt: job.updatedAt.toISOString(),
        });
  const read = (id) => prisma.job.findUniqueOrThrow({ where: { id } });
  const audits = (id) =>
    prisma.auditLog.count({ where: { tenantId, entityId: id } });
  const create = async (action = "RESCHEDULE") => {
    const start = new Date(Date.now() + (ids.length + 600) * 86400000);
    const job = await prisma.job.create({
      data: {
        ...jobData,
        intakeSessionId: randomUUID(),
        urgency: "STANDARD",
        policySnapshot: {
          depositRequired: true,
          paymentGateMode: "manual_override",
          // CREATE must have canonical admission before testing later policy
          // holds. This is a synthetic pre-approved exception, not a payment.
          ...(action === "CREATE"
            ? {
                paymentGateException: {
                  active: true,
                  approvedAt: new Date().toISOString(),
                  reason: "Synthetic pre-approved CREATE fixture",
                },
              }
            : {}),
          preserved: "fixture",
          urgencyDecision: { source: "AI_INTAKE", level: "STANDARD" },
        },
        status: action === "CREATE" ? "CREATED" : "ACCEPTED",
        calendarEventId: action === "CREATE" ? null : randomUUID(),
        serviceWindowStart: action === "CREATE" ? null : start,
        serviceWindowEnd:
          action === "CREATE" ? null : new Date(start.getTime() + 3600000),
      },
    });
    ids.push(job.id);
    return {
      job,
      input: {
        tenantId,
        jobId: job.id,
        expectedUpdatedAt: job.updatedAt,
        action,
        calendarId: "fixture@example.invalid",
        timeZone: "UTC",
        start: new Date(start.getTime() + 7200000),
        end: new Date(start.getTime() + 10800000),
        label: "Synthetic policy window",
      },
    };
  };
  // Inject a committed competing write after the consumer read, before its CAS.
  const interleave = (afterRead) => {
    let injected = false;
    return services({
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
                  await afterRead(job);
                }
                return job;
              },
            },
          }),
        ),
    });
  };
  const subscription = await prisma.tenantSubscription.create({
    data: {
      tenantId,
      stripeSubscriptionId: randomUUID(),
      planId: "growth",
      status: "ACTIVE",
      currentPeriodStart: new Date(Date.now() - 86400000),
      currentPeriodEnd: new Date(Date.now() + 86400000),
    },
  });
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
        const job = await read(fixture.job.id);
        await assert.rejects(
          mutate(normal, "urgency", job),
          /Calendar synchronization is unfinished/,
        );
        // Even same-value urgency replay must acknowledge the hold.
        await assert.rejects(
          normal.urgency.override({
            tenantId,
            jobId: job.id,
            actorId: jobData.assignedUserId,
            urgency: "STANDARD",
            reason: "Synthetic replay",
          }),
          /Calendar synchronization is unfinished/,
        );
        for (const policyAction of ["APPROVE", "REVOKE"])
          await assert.rejects(
            mutate(normal, "payment", job, policyAction),
            /Calendar synchronization is unfinished/,
          );
        assert.deepEqual(await read(job.id), job);
        assert.equal(await audits(job.id), 0);
        assert.equal(
          await prisma.payment.count({ where: { tenantId, jobId: job.id } }),
          0,
        );
        assert.equal(
          await prisma.smsEnqueueIntent.count({ where: { jobId: job.id } }),
          0,
        );
      }
      await prisma.calendarOperation.update({
        where: { id: operation.id },
        data: { status: "ABORTED", finishedAt: new Date() },
      });
      const job = await read(fixture.job.id);
      await mutate(normal, "urgency", job);
      if (action === "CANCEL")
        await assert.rejects(
          mutate(normal, "payment", await read(job.id)),
          /closed job/,
        );
      else {
        // CREATE entered with an approved fixture exception. Once the hold is
        // terminal, exercise revocation before the existing approve/revoke proof.
        if (action === "CREATE")
          await mutate(normal, "payment", await read(job.id), "REVOKE");
        await mutate(normal, "payment", await read(job.id));
        const approved = await read(job.id);
        assert.equal(approved.policySnapshot.urgencyDecision.level, "HIGH");
        assert.equal(approved.policySnapshot.paymentGateException.active, true);
        assert.equal(approved.policySnapshot.preserved, "fixture");
        await mutate(normal, "payment", approved, "REVOKE");
        assert.equal(
          (await read(job.id)).policySnapshot.paymentGateException.active,
          false,
        );
      }
    }
    for (const kind of ["urgency", "payment"]) {
      const reserved = await create();
      await assert.rejects(
        mutate(
          interleave(() => journal.reserve(reserved.input)),
          kind,
          reserved.job,
        ),
        /Job changed/,
      );
      assert.equal(await audits(reserved.job.id), 0);
      assert.equal(
        (await read(reserved.job.id)).policySnapshot.preserved,
        "fixture",
      );
      const first = await create();
      await mutate(normal, kind, first.job);
      assert.ok((await read(first.job.id)).updatedAt > first.job.updatedAt);
      await assert.rejects(
        journal.reserve(first.input),
        /changed or has unfinished/,
      );
      // Other policy writer wins: the loser may not overwrite its JSON snapshot.
      const policyRace = await create(),
        other = kind === "urgency" ? "payment" : "urgency";
      await assert.rejects(
        mutate(
          interleave(() => mutate(normal, other, policyRace.job)),
          kind,
          policyRace.job,
        ),
        /Job changed/,
      );
      const winner = await read(policyRace.job.id);
      assert.equal(await audits(winner.id), 1);
      if (other === "payment")
        assert.equal(winner.policySnapshot.paymentGateException.active, true);
      else assert.equal(winner.policySnapshot.urgencyDecision.level, "HIGH");
      assert.equal(winner.policySnapshot.preserved, "fixture");
      await assert.rejects(
        mutate(normal, kind, { ...winner, tenantId: otherTenantId }),
        /not found/,
      );
      const rollback = await create();
      const failing = services({
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
      });
      await assert.rejects(
        mutate(failing, kind, rollback.job),
        /audit failure/,
      );
      assert.deepEqual(await read(rollback.job.id), rollback.job);
      assert.equal(await audits(rollback.job.id), 0);
      await prisma.job.update({
        where: { id: rollback.job.id },
        data: { deletedAt: new Date() },
      });
      await assert.rejects(
        mutate(normal, kind, await read(rollback.job.id)),
        /not found/,
      );
    }
    return [
      "12 Calendar action/status combinations hold urgency replay and payment approve/revoke",
      "both policy mutations reject reservation-between-read-and-CAS",
      "policy version advances reject stale journal reservations",
      "competing urgency/payment snapshots preserve the winning policy and single audit",
      "tenant/deletion guards and terminal lifecycle semantics preserved",
      "both policy audit failures roll back actual job/version writes",
      "terminal policy approval/revocation preserve urgency and never create payment or provider activity",
    ];
  } finally {
    await prisma.calendarOperation.deleteMany({
      where: { tenantId, jobId: { in: ids } },
    });
    await prisma.tenantSubscription.delete({ where: { id: subscription.id } });
  }
}
