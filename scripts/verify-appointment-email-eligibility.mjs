// Parent-owned disposable Unix-socket PostgreSQL only. This reader never grants
// consent, invents expiry, creates credentials/queue records or calls a provider.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const load = (path, name) => require(`../dist/${path}.js`)[name];
const Eligibility = load(
  "communications/appointment-email-eligibility.service",
  "AppointmentEmailEligibilityService",
);
const Confirmation = load(
  "scheduling/appointment-confirmation.service",
  "AppointmentConfirmationService",
);
const Rescheduling = load(
  "scheduling/appointment-rescheduling.service",
  "AppointmentReschedulingService",
);
const Cancellation = load(
  "scheduling/appointment-cancellation.service",
  "AppointmentCancellationService",
);
const Intents = load(
  "communications/sms-enqueue-intent.service",
  "SmsEnqueueIntentService",
);
const Conversations = load(
  "conversations/conversations.service",
  "ConversationsService",
);
const Capture = load(
  "conversations/conversation-email.service",
  "ConversationEmailService",
);
const Cipher = load(
  "logging/conversation-memory-cipher.service",
  "ConversationMemoryCipher",
);
const Sanitize = load(
  "sanitization/sanitization.service",
  "SanitizationService",
);
const Journal = load(
  "scheduling/calendar-operation-journal.service",
  "CalendarOperationJournalService",
);
const Execution = load(
  "scheduling/calendar-create-execution.service",
  "CalendarCreateExecutionService",
);
const Reconciliation = load(
  "scheduling/calendar-create-reconciliation.service",
  "CalendarCreateReconciliationService",
);
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");

export async function verifyAppointmentEmailEligibility({
  prisma,
  jobData,
  otherTenantId,
}) {
  const [database] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(database.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(database.address, null);
  const tenantId = jobData.tenantId,
    cipher = new Cipher({ conversationDataEncryptionKey: "2".repeat(64) });
  const reader = new Eligibility(prisma, cipher),
    conversations = new Conversations(prisma, new Sanitize()),
    capture = new Capture(prisma, cipher);
  const sms = new Intents(prisma, {}, { smsDeliveryEnabled: false });
  const confirm = new Confirmation(prisma, sms, { error() {} }),
    cancel = new Cancellation(prisma, sms, { error() {} }),
    reschedule = new Rescheduling(prisma, sms, { error() {} });
  const original = await prisma.tenantOrganization.findUniqueOrThrow({
    where: { id: tenantId },
  });
  const enabled = {
    customerEmailPreferences: {
      version: 1,
      events: {
        APPOINTMENT_CONFIRMED: true,
        APPOINTMENT_RESCHEDULED: true,
        APPOINTMENT_CANCELLED: true,
      },
    },
  };
  const asActor = (fn, tenant = tenantId, role = "owner", impersonation) =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext(
          { userId: "synthetic-reviewer", tenantId: tenant, role },
          impersonation,
        );
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  let sequence = 0,
    checks = 0;
  const operationIds = [];
  const make = async (kind = "confirmed") => {
    const sessionId = randomUUID(),
      conversation = await conversations.ensureConversation(
        tenantId,
        sessionId,
      );
    await capture.observe(
      { tenantId, sessionId, conversationId: conversation.id },
      "Eligibility@example.invalid",
    );
    let job = await prisma.job.create({
      data: {
        ...jobData,
        status: "ACCEPTED",
        calendarEventId: null,
        intakeSessionId: sessionId,
        serviceWindowStart: new Date(Date.UTC(2053, 0, ++sequence, 14)),
        serviceWindowEnd: new Date(Date.UTC(2053, 0, sequence, 16)),
      },
    });
    const link = await prisma.conversationJobLink.create({
      data: {
        tenantId,
        jobId: job.id,
        jobTenantId: tenantId,
        conversationId: conversation.id,
        conversationTenantId: tenantId,
        relationType: "CREATED_FROM",
      },
    });
    if (kind === "readback") {
      const start = job.serviceWindowStart,
        end = job.serviceWindowEnd;
      job = await prisma.job.update({
        where: { id: job.id },
        data: {
          status: "CREATED",
          serviceWindowStart: null,
          serviceWindowEnd: null,
          assignedUserId: null,
          assignedUserTenantId: null,
          technicianStatus: null,
        },
      });
      const operation = await new Journal(prisma).reserve({
        tenantId,
        jobId: job.id,
        expectedUpdatedAt: job.updatedAt,
        action: "CREATE",
        calendarId: "synthetic@example.invalid",
        timeZone: "UTC",
        start,
        end,
        label: "Synthetic window",
      });
      const input = { tenantId, operationId: operation.id };
      operationIds.push(operation.id);
      await new Execution(
        prisma,
        { create: async () => {} },
        { reconcile: async () => ({ status: "pending" }) },
      ).execute(input);
      await new Reconciliation(
        prisma,
        {
          read: async () => ({
            outcome: "found",
            event: {
              id: operation.calendarEventId,
              status: "confirmed",
              etag: '"synthetic"',
              start: start.toISOString(),
              end: end.toISOString(),
              tenantId,
              jobId: job.id,
              operationId: operation.id,
              blockingSingleEvent: true,
            },
          }),
        },
        sms,
      ).reconcile(input);
    } else
      job = await confirm.finalize({
        tenantId,
        jobId: job.id,
        start: job.serviceWindowStart,
        end: job.serviceWindowEnd,
        calendarEventId: `synthetic-${randomUUID()}`,
      });
    if (kind === "cancelled")
      await cancel.finalize(await cancel.claim(job, "prior window"));
    if (kind === "rescheduled")
      await reschedule.finalize(
        await reschedule.claim(
          job,
          new Date(job.serviceWindowStart.getTime() + 365 * 86400000),
          new Date(job.serviceWindowEnd.getTime() + 365 * 86400000),
          "new window",
        ),
        "old",
        "new",
      );
    job = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const event = await prisma.appointmentEmailIntent.findFirstOrThrow({
      where: {
        jobId: job.id,
        kind: `APPOINTMENT_${kind === "readback" ? "CONFIRMED" : kind.toUpperCase()}`,
      },
    });
    return {
      job,
      event,
      conversation: await prisma.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
      }),
      link,
    };
  };
  const state = async () => {
    const snapshot = {};
    for (const name of [
      "tenantOrganization",
      "job",
      "customer",
      "conversation",
      "conversationJobLink",
      "auditLog",
      "appointmentEmailIntent",
      "appointmentCancellationSnapshot",
      "smsEnqueueIntent",
      "communicationEvent",
      "calendarOperation",
    ])
      snapshot[name] = await prisma[name].findMany();
    return snapshot;
  };
  const review = async (fixture, reason, options = {}) => {
    const before = await state();
    if (options.status)
      await assert.rejects(
        () =>
          asActor(
            () => reader.evaluate({ intentId: fixture.event.id }),
            options.tenant,
            options.role,
            options.impersonation,
          ),
        (error) => error.getStatus?.() === options.status,
      );
    else {
      const result = await asActor(() =>
        reader.evaluate({ intentId: fixture.event.id }),
      );
      assert.equal(result.reason, reason);
      assert.equal(result.eligible, false);
      assert.equal(result.deliveryAuthorized, false);
      assert.equal(result.snapshotOnly, true);
      assert.doesNotMatch(
        JSON.stringify(result),
        /Eligibility@|encryptedEmail|synthetic-|managementUrl|subject|calendarEventHash/,
      );
      if (reason === "CONSENT_AUTHORITY_UNAVAILABLE") {
        assert.ok(
          Math.abs(Date.now() - Date.parse(result.binding.reviewedAt)) < 30000,
          "UTC review timestamp must not inherit database session timezone",
        );
        assert.deepEqual(result.blockers, [
          "CONSENT_AUTHORITY_UNAVAILABLE",
          "EXPIRY_POLICY_UNAVAILABLE",
        ]);
        assert.equal(result.binding.intentId, fixture.event.id);
        assert.equal(
          result.binding.jobUpdatedAt,
          fixture.job.updatedAt.toISOString(),
        );
        assert.equal(result.binding.conversationId, fixture.conversation.id);
      }
    }
    assert.deepEqual(await state(), before);
    checks++;
  };
  try {
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings: enabled },
    });
    for (const kind of ["confirmed", "rescheduled", "cancelled", "readback"])
      await review(await make(kind), "CONSENT_AUTHORITY_UNAVAILABLE");
    const fixture = await make();
    const pending = await make();
    const pendingOperation = await new Journal(prisma).reserve({
      tenantId,
      jobId: pending.job.id,
      expectedUpdatedAt: pending.job.updatedAt,
      action: "CANCEL",
      calendarId: "synthetic@example.invalid",
      timeZone: "UTC",
    });
    operationIds.push(pendingOperation.id);
    // Even a deliberately restored fixture version cannot evade the pending journal.
    await prisma.job.update({
      where: { id: pending.job.id },
      data: {
        status: pending.job.status,
        updatedAt: pending.job.updatedAt,
        calendarEventId: pending.job.calendarEventId,
        serviceWindowStart: pending.job.serviceWindowStart,
        serviceWindowEnd: pending.job.serviceWindowEnd,
      },
    });
    await review(pending, "CALENDAR_PENDING");
    // Finish the synthetic journal so the parent's normal retention cleanup is allowed.
    await prisma.calendarOperation.updateMany({
      where: { jobId: pending.job.id },
      data: { status: "FINALIZED", finishedAt: new Date() },
    });
    await prisma.job.update({
      where: { id: pending.job.id },
      data: { deletedAt: new Date() },
    });
    await review(pending, null, { status: 404 });
    await review(fixture, null, { tenant: otherTenantId, status: 404 });
    await review(fixture, null, { role: "dispatcher", status: 403 });
    await review(fixture, null, { impersonation: tenantId, status: 403 });
    for (const [settings, reason] of [
      [{}, "CURRENT_POLICY_BLOCKED"],
      [{ customerEmailPreferences: { version: 99 } }, "CURRENT_POLICY_INVALID"],
    ]) {
      await prisma.tenantOrganization.update({
        where: { id: tenantId },
        data: { settings },
      });
      await review(fixture, reason);
    }
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings: {} },
    });
    const blocked = await make();
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings: enabled },
    });
    await review(blocked, "EVENT_POLICY_BLOCKED");
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings: { customerEmailPreferences: { version: 99 } } },
    });
    const invalid = await make();
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings: enabled },
    });
    await review(invalid, "EVENT_POLICY_INVALID");
    for (const patch of [
      { updatedAt: new Date(fixture.job.updatedAt.getTime() + 1) },
      { calendarEventId: "changed", updatedAt: fixture.job.updatedAt },
      { intakeSessionId: randomUUID(), updatedAt: fixture.job.updatedAt },
    ]) {
      await prisma.job.update({ where: { id: fixture.job.id }, data: patch });
      await review(fixture, "EVENT_STALE");
      await prisma.job.update({
        where: { id: fixture.job.id },
        data: {
          updatedAt: fixture.job.updatedAt,
          calendarEventId: fixture.job.calendarEventId,
          intakeSessionId: fixture.job.intakeSessionId,
        },
      });
    }
    const audit = await prisma.auditLog.findUniqueOrThrow({
      where: { id: fixture.event.sourceAuditId },
    });
    await prisma.auditLog.update({
      where: { id: audit.id },
      data: { actorId: "customer:wrong" },
    });
    await review(fixture, "EVENT_INVALID");
    await prisma.auditLog.update({
      where: { id: audit.id },
      data: { actorId: audit.actorId },
    });
    for (const collectedData of [
      {
        ...fixture.conversation.collectedData,
        intakeEmail: { version: 1, status: "declined", askedAt: null },
      },
      { ...fixture.conversation.collectedData, sessionId: "wrong" },
    ]) {
      await prisma.conversation.update({
        where: { id: fixture.conversation.id },
        data: { collectedData },
      });
      await review(fixture, "RECIPIENT_UNAVAILABLE");
    }
    await prisma.conversation.update({
      where: { id: fixture.conversation.id },
      data: { collectedData: fixture.conversation.collectedData },
    });
    const duplicate = await prisma.conversationJobLink.create({
      data: {
        tenantId,
        jobId: fixture.job.id,
        jobTenantId: tenantId,
        conversationId: blocked.conversation.id,
        conversationTenantId: tenantId,
        relationType: "CREATED_FROM",
      },
    });
    await review(fixture, "RECIPIENT_UNAVAILABLE");
    await prisma.conversationJobLink.delete({ where: { id: duplicate.id } });
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { status: "SUSPENDED" },
    });
    await review(fixture, null, { status: 404 });
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { status: original.status },
    });
    // A real separate connection commits recipient and policy revocation between
    // SELECTs. RepeatableRead must retain one coherent historical diagnostic;
    // the fresh review must observe revocation. Neither read grants admission.
    let hooked = false;
    const raced = new Eligibility(
      {
        $transaction: (fn, options) =>
          prisma.$transaction(
            (tx) =>
              fn(
                new Proxy(tx, {
                  get(target, key) {
                    if (key !== "$queryRaw") return target[key];
                    return async (...args) => {
                      const result = await tx.$queryRaw(...args);
                      if (!hooked) {
                        hooked = true;
                        await prisma.tenantOrganization.update({
                          where: { id: tenantId },
                          data: { settings: {} },
                        });
                        await prisma.conversation.update({
                          where: { id: fixture.conversation.id },
                          data: {
                            collectedData: {
                              ...fixture.conversation.collectedData,
                              intakeEmail: {
                                version: 1,
                                status: "declined",
                                askedAt: null,
                              },
                            },
                          },
                        });
                      }
                      return result;
                    };
                  },
                }),
              ),
            options,
          ),
      },
      cipher,
    );
    const result = await asActor(() =>
      raced.evaluate({ intentId: fixture.event.id }),
    );
    assert.equal(result.reason, "CONSENT_AUTHORITY_UNAVAILABLE");
    assert.equal(result.deliveryAuthorized, false);
    await review(fixture, "CURRENT_POLICY_BLOCKED");
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings: enabled },
    });
    await review(fixture, "RECIPIENT_UNAVAILABLE");
    // PostgreSQL, not a convention, rejects attempted writes inside this reader.
    const before = await state();
    const attemptedWrite = new Eligibility(
      {
        $transaction: (fn, options) =>
          prisma.$transaction(
            (tx) =>
              fn(
                new Proxy(tx, {
                  get(target, key) {
                    if (key !== "$queryRaw") return target[key];
                    return async (...args) => {
                      await tx.job.update({
                        where: { id: fixture.job.id },
                        data: { preferredTimeText: "forbidden-write" },
                      });
                      return tx.$queryRaw(...args);
                    };
                  },
                }),
              ),
            options,
          ),
      },
      cipher,
    );
    await assert.rejects(
      () =>
        asActor(() => attemptedWrite.evaluate({ intentId: fixture.event.id })),
      /Email eligibility review is unavailable/,
    );
    assert.deepEqual(await state(), before);
    const summary = {
      result: "PASS",
      scope: "Inactive read-only eligibility diagnostic; zero admitted events",
      invariantCheckedReads: checks,
      kinds: 3,
      atomicSnapshotRace: true,
      databaseWriteRefused: true,
      providerCalls: 0,
      migrationsAdded: 0,
      checks: [
        "All three actual finalizer events plus CREATE read-back bind retained recipient; consent and expiry missing always refuse",
        "Pending Calendar and deleted job refuse",
        "Every ordinary review leaves eleven business tables unchanged",
        "Wrong tenant/role/impersonation and suspended tenant refuse",
        "Event-time blocked/invalid never resurrected by current permission",
        "Current policy revocation/invalid state refuses",
        "Changed version/provider/session and invalid audit refuse",
        "Declined/wrong-session/ambiguous recipient refuses",
        "RepeatableRead retains one snapshot across committed policy/recipient revocation; fresh review sees revocation",
        "Read-only transaction enforces no writes",
        "No address, credentials, body or raw provider reference returned",
      ],
    };
    const directory =
      process.env.EMAIL_ELIGIBILITY_EVIDENCE_DIR ??
      fileURLToPath(
        new URL("../evidence/APP-013/email-eligibility/", import.meta.url),
      );
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "database-summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
    );
    return summary.checks.map((check) => "email eligibility: " + check);
  } finally {
    // Only this fixture's two synthetic journal records; their RESTRICT FKs
    // intentionally prevent the parent's later tenant-retention deletion.
    await prisma.calendarOperation.deleteMany({
      where: { tenantId, id: { in: operationIds } },
    });
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings: original.settings, status: original.status },
    });
  }
}
